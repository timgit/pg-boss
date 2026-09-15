# Scheduling

Jobs may be created automatically based on a cron expression or an [RRULE](#rrule-expressions). As with other cron-based systems, at least one instance needs to be running for scheduling to work. In order to reduce the amount of evaluations, schedules are checked every 30 seconds, which means the 6-placeholder format should be discouraged in favor of the minute-level precision 5-placeholder format.

For example, use this format, which implies "any second during 3:30 am every day"

```
30 3 * * *
```

but **not** this format which is parsed as "only run exactly at 3:30:30 am every day"

```
30 30 3 * * *
```

To change how often schedules are checked, you can set `cronMonitorIntervalSeconds`. To change how often cron jobs are run, you can set `cronWorkerIntervalSeconds`.

In order mitigate clock skew and drift, every 10 minutes the clocks of each instance are compared to the database server's clock. The skew, if any, is stored and used as an offset during cron evaluation to ensure all instances are synchronized. Internally, job throttling options are then used to make sure only 1 job is sent even if multiple instances are running.

If needed, the default clock monitoring interval can be adjusted using `clockMonitorIntervalSeconds`. Cron evaluation reads the time from the instance's [`clock`](./constructor.md#newoptions) option, so a [`TestClock`](./testing.md#controlling-time) can move a schedule to its next occurrence without waiting for it. Additionally, to disable scheduling on an instance completely, use the following in the constructor options.

```js
{
  schedule: false
}
```

For more cron documentation and examples see the docs for the [cron-parser package](https://www.npmjs.com/package/cron-parser).

## RRULE expressions

An expression carrying a `FREQ=` part, or a line that opens with an iCalendar property such as `DTSTART` or `RRULE`, is read as a recurrence rule as defined in [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.10) and evaluated by [rrule-temporal](https://www.npmjs.com/package/rrule-temporal). Everything else is a cron expression, which cannot be mistaken for a rule since no cron field contains `=`, `:` or `;`.

Rules cover the schedules cron cannot express: the last Friday of the month, every second Monday, a schedule that stops on a date or after a number of runs.

```js
// 5pm on the last Friday of the month, Chicago time
await boss.schedule('report', 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', null, { tz: 'America/Chicago' })
```

The expression is either the rule on its own, as above, or the recurrence lines of a calendar entry: a `DTSTART` line, the `RRULE` line, and optional `RDATE` and `EXDATE` lines. Paste those lines rather than a whole export, since a `UID`, a `SUMMARY` or the `BEGIN` and `END` lines around them say nothing about when a job should run and are rejected:

```js
await boss.schedule('standup', [
  'DTSTART;TZID=Europe/Berlin:20260901T090000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  'EXDATE;TZID=Europe/Berlin:20261224T090000'
].join('\n'))
```

* **Time zone**

  `DTSTART` decides it when it names one, as `DTSTART;TZID=Europe/Berlin:20260901T090000` does. Otherwise the `tz` option does, so `FREQ=DAILY;BYHOUR=9` with `tz: 'America/Chicago'` runs at nine in Chicago, across daylight saving transitions.

* **DTSTART**

  A rule that carries no `DTSTART` is anchored on 1970-01-01T00:00:00 in the schedule's time zone, the same anchor in every instance and every release. That anchor is what an `INTERVAL` counts from, so `FREQ=HOURLY;INTERVAL=6` runs every six hours from midnight on the epoch. Supply a `DTSTART` to choose the phase yourself. `COUNT` is rejected without one, since counting from the epoch leaves a rule with nothing left to send.

  An `HOURLY`, `MINUTELY` or `SECONDLY` `INTERVAL` counts elapsed time rather than clock time, and the epoch anchor falls in standard time, so in a zone that observes daylight saving the local time of those occurrences moves with the offset: `FREQ=HOURLY;INTERVAL=6` with `tz: 'America/Chicago'` lands on 00:00, 06:00, 12:00 and 18:00 in January and on 01:00, 07:00, 13:00 and 19:00 in July. Name the hours to pin them to the clock instead. `FREQ=DAILY;BYHOUR=0,6,12,18` holds across a transition, as `0 */6 * * *` does.

* **Finite rules**

  `UNTIL` and `COUNT` are honored. Once the last occurrence has passed, the schedule stays in the table and sends nothing further. A rule that has nothing left to send when `schedule()` is called is rejected instead of stored, since a schedule that quietly does nothing is a failure nobody sees.

* **Resolution**

  Schedules are checked every 30 seconds, and a job is filed under the minute its occurrence falls in, so a rule finer than a minute, such as `FREQ=SECONDLY` or a `BYSECOND` list, sends one job for each minute that holds an occurrence. This is the same limitation the 6-placeholder cron format has, and for the same reason. Two occurrences in separate minutes both send, however close together they are: an `RDATE` seconds before one of an hourly rule's own occurrences produces two jobs, not one.

* **Stored format**

  `schedule()` decides which format an expression is in, once, and stores the answer in the schedule table's `kind` column (`cron` or `rrule`); `getSchedules()` returns it. Every pass reads the expression the way that column says, so the format cannot be settled one way at validation and another way later. A row written straight into the table with SQL has to name its own kind, since the column defaults to `cron`, which is what every schedule stored before rules existed is.

  The column is a hint rather than a verdict. When an expression cannot be read the way the column says, and is written the other way, the pass reads it the way it is written and corrects the column. So a row that has lost its label, to a schema rollback and re-upgrade or to an upsert from an instance too old to know the column, keeps firing instead of sitting there looking valid.

A rule is understood by any instance running a release that supports one. During a rolling upgrade an instance still on an older release reads the expression as cron, cannot parse it, and reports an [`invalid_schedule`](./events.md#warning) warning until it is replaced, so rule schedules are best added once the deployment is upgraded.

`schedule()` validates the expression, so a rule that would be read differently than it was meant is rejected before it reaches the table:

* an unknown part such as `BYHOURS=9`, or an unknown property such as `DTSRAT`, which a parser drops before evaluating the rest
* a value out of range, such as `BYHOUR=25` or the `25` in `BYHOUR=9,25`, which a parser drops just as quietly
* a part named twice, such as `BYHOUR=9;BYHOUR=17`, where the second replaces the first rather than widening it
* an expression with no `RRULE` to recur on, such as `DTSTART` and `RDATE` lines on their own
* a second `DTSTART` or `RRULE`
* an `RDATE` or `EXDATE` given as a date where `DTSTART` is a date time, which excludes or adds midnight rather than the occurrence it names
* the combinations RFC 5545 forbids outright, such as `BYMONTHDAY` with a weekly frequency
* a time zone no evaluation can use, reported in the same words a cron schedule reports it in

## Catch-up after an outage

A pass sends the occurrences of the preceding 60 seconds, so an occurrence that came due while no instance was running a pass is not sent at all: a deployment that was down, or between deploys, for an hour never sends what that hour held. The `missed` option decides what a schedule does about that.

| `missed` | What a schedule sends for a gap |
| --- | --- |
| `skip` | Nothing. The default, and what every earlier release did |
| `once` | One job, for the most recent missed occurrence, however many were missed |

```js
// a nightly report reads the current state of the world, so three missed nights are one report
await boss.schedule('report', '0 3 * * *', null, { missed: 'once' })
```

The gap runs from the last time any instance ran a cron pass, which pg-boss records on its version row, to the moment the due window opens. Passes claim every `cronMonitorIntervalSeconds` (30 by default, 45 at the ceiling) against a 60-second window, so a deployment whose passes keep running has no gap and the option costs it nothing. A gap opens when the passes stop: the deployment is down, in the middle of a deploy, or running with `schedule: false`.

A schedule never reaches back past its own row. `created_on` bounds the range, so a schedule written while nothing was running starts from when it was written rather than from the start of the outage. Re-running `schedule()` for an existing `(name, key)` leaves that bound where it is, which is what lets a deployment that registers its schedules on every boot still catch up on the outage it just ended.

The option applies to both formats, and a rule is read backwards over the gap the same way a cron expression is.

Worth knowing before choosing `once`:

* **A caught-up job is indistinguishable from an on-time one.** It carries the schedule's `data` unchanged and is created when the pass catches up, so a handler cannot tell it is late or which occurrence it stands for. That is what makes `once` the whole of the option: a job whose meaning is "catch up to now" needs no occurrence identity, and a policy sending a job per missed occurrence would need one the payload has no way to carry.

* **The occurrence it names is the most recent one in the gap.** Three days down sends one job for last night's occurrence, and the two nights before it are not sent at all.

* **It can arrive beside the occurrence that is due now.** Those are two jobs: the catch-up job is filed under the minute its occurrence fell in and the due one under the minute the pass is running in, so the two do not collapse into one. A schedule whose most recent missed occurrence shares a minute with a due one sends a single job, since they share that slot.

* **Queue policy and send options apply to it like any other job.** A `singletonKey` in the schedule's options, or a queue whose policy allows one queued job (`short`, `stately`, `exclusive`), can collapse the catch-up job and the due one into whichever the policy allows.

The pass that reads a gap is also the one that closes it, so an occurrence lost to a pass that claimed and then failed is not caught up by the next one. During a rolling upgrade, an instance on a release without catch-up runs passes that close a gap without catching up on it.

## Managing schedules

### `schedule(name, cron, data, options)`

Schedules a job to be sent to the specified queue based on a cron expression or an [RRULE](#rrule-expressions). If the schedule already exists, it's updated to the new expression.

**Arguments**

- `name`: string, *required*
- `cron`: string, *required*. A cron expression, or an [RRULE](#rrule-expressions)
- `data`: object
- `options`: object

`options` supports all properties in `send()` as well as the following additional options.

* **tz**

  An optional time zone name. If not specified, the default is UTC, and so is a `null` or empty
  one: those say no zone was chosen, which is what a value threaded out of a config object or read
  back off a schedule row written before zones were validated looks like. An unrecognized zone is
  rejected by `schedule()`, so a typo cannot be stored and then fail on the cron pass.

* **key**
  
  An optional unique key if more than schedule is needed for this queue.

* **missed**

  What the schedule sends for occurrences that came due while no cron pass ran: `skip` (the
  default) or `once`. See [Catch-up after an outage](#catch-up-after-an-outage). A `null` policy
  reads as none given, like a `null` zone; any other value is rejected.


For example, the following code will send a job at 3:00am in the US central time zone into the queue `notification-abc`.

```js
await boss.schedule('notification-abc', `0 3 * * *`, null, { tz: 'America/Chicago' })
```

### `unschedule(name)`

Removes all scheduled jobs for the specified queue name.

```js
await boss.unschedule('notification-abc')
```

### `unschedule(name, key)`

Removes a schedule by queue name and unique key.

```js
// create two schedules on the same queue, then remove just one
await boss.schedule('report', '0 6 * * *', { region: 'us' }, { key: 'us' })
await boss.schedule('report', '0 18 * * *', { region: 'eu' }, { key: 'eu' })

await boss.unschedule('report', 'eu')
```

### `getSchedules()`

Returns all scheduled jobs.

Each schedule carries the expression in `cron`, the format it is in as `kind` (`cron` or `rrule`), the time zone it is evaluated in, and the `data` and `options` its jobs are sent with.

```js
const schedules = await boss.getSchedules()

for (const schedule of schedules) {
  console.log(`${schedule.name} (${schedule.key}): ${schedule.kind} ${schedule.cron} ${schedule.timezone}`)
}
```

Each schedule carries the following properties.

| Property | Description |
| --- | --- |
| `name` | Queue the schedule sends into |
| `key` | Unique key within the queue, `''` when none was supplied |
| `kind` | Which format `cron` holds, `cron` or `rrule` |
| `cron` | Cron expression or recurrence rule |
| `timezone` | Time zone the expression is evaluated in, `UTC` when the row never named one |
| `data` | Payload sent with each job |
| `options` | The options `schedule()` was given: the `send()` options each job is created with, and `tz`, `key` and `missed` beside them |
| `createdOn` | When the schedule was first stored |
| `updatedOn` | When the definition was last changed |
| `lastJobId` | Id of the job the schedule most recently created |

`lastJobId` connects a schedule to its last run, so a queue's history can be inspected from the
schedule that produced it.

```js
const [schedule] = await boss.getSchedules('report', 'eu')

if (schedule.lastJobId) {
  const [job] = await boss.findJobs('report', { id: schedule.lastJobId })

  // null once the job passes the queue's retention window
  console.log(job?.state)
}
```

`lastJobId` is not a foreign key: the job it names is subject to the queue's retention policy and is
eventually deleted, so it may no longer exist. Re-running `schedule()` for the same `(name, key)`
updates the definition and leaves `lastJobId` alone; `unschedule()` removes the row entirely.

It is recorded on a best-effort basis, in a separate statement once the job has been created, so
`null` does not prove a schedule never fired. A schedule that last fired before the upgrade adding
the column reads `null` until its next run, and so does one whose annotating statement failed after
its job was already created. Treat it as a pointer to the last run pg-boss observed, not as a
complete firing record: the queue's job history is the authority on what actually ran.

### `getSchedules(name)`

Returns all scheduled jobs by queue name.

```js
const schedules = await boss.getSchedules('report')
```

### `getSchedules(name, key)`

Returns all scheduled jobs by queue name and unique key.

```js
const [schedule] = await boss.getSchedules('report', 'eu')
```

### `getSchedule(name, key)`

Returns the schedule for a queue name and unique key, or `null` if there is none. `key` defaults to
the empty string, the key `schedule()` uses when none is supplied.

Unlike `getSchedules(name, key)`, which always returns an array, this reads the one row a
`(name, key)` pair can have.

```js
const schedule = await boss.getSchedule('report', 'eu')

if (schedule) {
  console.log(`${schedule.cron} ${schedule.timezone}`)
}
```

### `previewSchedule(cron, options)`

Returns the next occurrences an expression produces, as an array of `Date`. A cron expression or an
[RRULE](#rrule-expressions), told apart the same way `schedule()` tells them apart, so a stored
schedule can be previewed from its `cron` column without consulting its `kind`. The expression and
time zone are validated exactly as `schedule()` validates them, so anything this previews can also
be stored.

This is pure computation: it does not query the database and does not require a started instance.

**Arguments**

- `cron`: string, *required*. A cron expression, or an [RRULE](#rrule-expressions)
- `options`: object

**options**

* **tz**, string, *default: `UTC`*

  Time zone the expression is evaluated in. A `null` or empty zone is read as none given, so
  previewing a stored schedule from its `timezone` column works whatever release wrote the row.

* **from**, Date, *default: database time*

  Reference point the walk starts from. Occurrences are strictly after it, so passing the last
  occurrence of one page back in yields the next page.

  The default is this instance's clock plus the skew cached against the database, the same reading
  the cron pass evaluates against. Skew is only cached by an instance started with `schedule`
  enabled; on any other instance, including a proxy running with its default of `schedule: false`,
  it is zero and the default reduces to the local clock of the calling process. Pass `from`
  explicitly when the reference point has to be exact.

* **count**, number, *default: 5*

  How many occurrences to return. Must be an integer between 1 and 1000. A finite rule answers with
  fewer, and a rule whose last occurrence has passed answers with none: `schedule()` refuses to
  store one of those, and previewing a stored one is how a caller finds out it has finished.

  Occurrences of a sparse expression are expensive to find, and the walk is synchronous, so it also
  gives up after a second rather than hold the event loop for as long as the count would take. Ask
  for fewer and page with `from` if that happens.

```js
boss.previewSchedule('0 3 * * *', { tz: 'America/Chicago', count: 3 })

boss.previewSchedule('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', { tz: 'America/Chicago', count: 3 })
```

The result describes the expression, not the delivery. Schedules are checked every
`cronMonitorIntervalSeconds` and an occurrence within the preceding 60 seconds is sent, so a job
lands at or shortly after each listed time.

To preview a stored schedule, read it first:

```js
const schedule = await boss.getSchedule('report', 'eu')

if (schedule) {
  const upcoming = boss.previewSchedule(schedule.cron, { tz: schedule.timezone })
}
```
