# Scheduling

pg-boss can create jobs on a schedule from a cron expression or an [RRULE](#rrule-expressions). As with other cron-based systems, at least one instance must be running for scheduling to work. To keep evaluations down, pg-boss checks schedules every 30 seconds and files each job under the minute its occurrence falls in. So a schedule sends at most one job a minute, and a job can be created up to one check interval after its occurrence. The seconds field of the 6-placeholder cron format adds no precision below a minute, and neither does an RRULE's `BYSECOND` or `FREQ=SECONDLY`. Prefer minute-level expressions such as the 5-placeholder cron format.

For example, use this format, which implies "any second during 3:30 am every day"

```
30 3 * * *
```

but **not** this format, which is parsed as "only run exactly at 3:30:30 am every day"

```
30 30 3 * * *
```

Set `cronMonitorIntervalSeconds` to change how often schedules are checked, and `cronWorkerIntervalSeconds` to change how often cron jobs run.

To limit clock skew and drift, every 10 minutes each instance compares its clock to the database server's clock. pg-boss stores any skew and uses it as an offset during cron evaluation, so all instances stay synchronized. pg-boss then uses job throttling internally so only 1 job is sent, even when several instances are running.

Set `clockMonitorIntervalSeconds` to change the clock monitoring interval. Cron evaluation reads the time from the instance's [`clock`](./constructor.md#clock) option, so a [`TestClock`](./testing.md#controlling-time) can move a schedule to its next occurrence without waiting for it. To turn scheduling off on an instance, pass this in the constructor options.

```js
{
  schedule: false
}
```

For more cron documentation and examples, see the docs for the [cron-parser package](https://www.npmjs.com/package/cron-parser).

## RRULE expressions

pg-boss reads an expression as a recurrence rule, as defined in [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.10), when it has a `FREQ=` part or a line that opens with an iCalendar property such as `DTSTART` or `RRULE`. [rrule-temporal](https://www.npmjs.com/package/rrule-temporal) evaluates it. Everything else is a cron expression, and no cron field contains `=`, `:` or `;`, so a cron expression can't be mistaken for a rule.

Rules cover the schedules cron can't express: the last Friday of the month, every second Monday, a schedule that stops on a date or after a number of runs.

```js
// 5pm on the last Friday of the month, Chicago time
await boss.schedule('report', 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', null, { tz: 'America/Chicago' })
```

The expression is either the rule on its own, as above, or the recurrence lines of a calendar entry: a `DTSTART` line, the `RRULE` line, and optional `RDATE` and `EXDATE` lines. Paste only those lines. `schedule()` rejects the rest of an export, such as a `UID`, a `SUMMARY` or the `BEGIN` and `END` lines around them, because they say nothing about when a job should run.

```js
await boss.schedule('standup', [
  'DTSTART;TZID=Europe/Berlin:20260901T090000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  'EXDATE;TZID=Europe/Berlin:20261224T090000'
].join('\n'))
```

* **Time zone**

  When `DTSTART` names a time zone, as `DTSTART;TZID=Europe/Berlin:20260901T090000` does, the rule uses it. Otherwise the `tz` option sets it, so `FREQ=DAILY;BYHOUR=9` with `tz: 'America/Chicago'` runs at nine in Chicago, across daylight saving transitions.

* **DTSTART**

  A rule with no `DTSTART` is anchored on 1970-01-01T00:00:00 in the schedule's time zone, the same anchor in every instance and every release. An `INTERVAL` counts from that anchor, so `FREQ=HOURLY;INTERVAL=6` runs every six hours from midnight on the epoch. Supply a `DTSTART` to choose the phase yourself. pg-boss rejects `COUNT` without one, since counting from the epoch leaves a rule with nothing left to send.

  An `HOURLY`, `MINUTELY` or `SECONDLY` `INTERVAL` counts elapsed time instead of clock time, and the epoch anchor falls in standard time. So in a zone that observes daylight saving, the local time of those occurrences moves with the offset. `FREQ=HOURLY;INTERVAL=6` with `tz: 'America/Chicago'` lands on 00:00, 06:00, 12:00 and 18:00 in January and on 01:00, 07:00, 13:00 and 19:00 in July. To pin the hours to the clock, name them. `FREQ=DAILY;BYHOUR=0,6,12,18` holds across a transition, as `0 */6 * * *` does.

* **Finite rules**

  pg-boss honors `UNTIL` and `COUNT`. Once the last occurrence has passed, the schedule stays in the table and sends nothing more. `schedule()` rejects a rule that has nothing left to send instead of storing it, since a schedule that quietly does nothing is a failure nobody sees.

* **Resolution**

  pg-boss checks schedules every 30 seconds and files a job under the minute its occurrence falls in. So a rule finer than a minute, such as `FREQ=SECONDLY` or a `BYSECOND` list, sends one job for each minute that holds an occurrence. The 6-placeholder cron format has the same limit, for the same reason. Two occurrences in separate minutes both send, however close together they are. For example, an `RDATE` seconds before one of an hourly rule's own occurrences produces two jobs.

* **Stored format**

  `schedule()` works out which format an expression is in once, and stores the answer in the schedule table's `kind` column (`cron` or `rrule`), which `getSchedules()` returns. Every pass reads the expression the way that column says, so validation and later passes can't read the format differently. A row written straight into the table with SQL has to name its own kind, because the column defaults to `cron`, the format of every schedule stored before rules existed.

  The column is only a hint. When an expression can't be read the way the column says but is written in the other format, the pass reads it as written and corrects the column. So a row that lost its label keeps firing instead of sitting there looking valid. A schema rollback and re-upgrade can lose the label, and so can an upsert from an instance too old to know the column.

Any instance on a release that supports rules can read one. During a rolling upgrade, an instance still on an older release reads the expression as cron, can't parse it, and reports an [`invalid_schedule`](./events.md#warning) warning until it's replaced. Add rule schedules once the deployment is upgraded.

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

A pass sends the occurrences of the preceding 60 seconds, so an occurrence that came due while no instance was running a pass is never sent. A deployment that was down, or between deploys, for an hour never sends what that hour held. The `missed` option sets what a schedule does about that.

| `missed` | What a schedule sends for a gap |
| --- | --- |
| `skip` | Nothing. The default |
| `once` | One job, for the most recent missed occurrence, however many were missed |

```js
// a nightly report reads the current state of the world, so three missed nights are one report
await boss.schedule('report', '0 3 * * *', null, { missed: 'once' })
```

The gap runs from the last time any instance ran a cron pass, which pg-boss records on its version row, to the moment the due window opens. Passes run every `cronMonitorIntervalSeconds` (30 by default, 45 at the ceiling) against a 60-second window, so a deployment that keeps running has no gap and the option costs it nothing. A gap opens when the passes stop: the deployment is down, in the middle of a deploy, or running with `schedule: false`.

A schedule never catches up on time before its own row was written. `created_on` bounds the range, so a schedule written while nothing was running catches up only from when it was written. Re-running `schedule()` for an existing `(name, key)` leaves that bound where it is, so a deployment that registers its schedules on every boot still catches up on the outage it just ended.

The option applies to both formats, and a rule is read backwards over the gap the same way a cron expression is.

Consider these before choosing `once`:

* **One job for the whole gap, and it looks like any other.** It carries the schedule's `data` unchanged, so a handler can't tell that it's late or which occurrence it stands for. Three days of downtime sends one job for last night's occurrence and nothing for the two nights before it.

* **It can arrive beside the occurrence that is due now.** Those are two jobs, filed under different minutes, unless the missed occurrence happens to share a minute with the due one. A `singletonKey`, or a queue policy that allows one queued job (`short`, `stately`, `exclusive`), collapses them like any other pair.

* **The pass that reads a gap closes it.** If a pass claims a gap and then fails, the next pass doesn't catch up on the occurrences it lost. An instance on a release without catch-up also closes gaps without catching up on them.

## Managing schedules

### `schedule(name, cron, data, options)`

Creates a schedule that sends jobs to the queue on a cron expression or an [RRULE](#rrule-expressions). If the schedule already exists, `schedule()` updates it to the new expression.

**Arguments**

- `name`: string, *required*
- `cron`: string, *required*. A cron expression, or an [RRULE](#rrule-expressions)
- `data`: object
- `options`: object

`options` takes every `send()` option, plus the following.

* **tz**

  An optional time zone name. It defaults to UTC, and a `null` or empty zone also means UTC.
  pg-boss reads those as no zone chosen, which is how a value threaded out of a config object looks,
  or one read back off a schedule row written before zones were validated. `schedule()` rejects an
  unrecognized zone, so a typo can't be stored and then fail on the cron pass.

* **key**
  
  An optional unique key, for when the queue needs more than one schedule.

* **missed**

  What the schedule sends for occurrences that came due while no cron pass ran: `skip` (the
  default) or `once`. See [Catch-up after an outage](#catch-up-after-an-outage). A `null` policy
  counts as none given, like a `null` zone. `schedule()` rejects any other value.

* **db**

  An optional [database adapter](./adapters.md) to run the write on, such as one wrapping a transaction. pg-boss uses it for this call only and doesn't store it with the schedule.


For example, this sends a job to the queue `notification-abc` at 3:00am in the US Central time zone.

```js
await boss.schedule('notification-abc', `0 3 * * *`, null, { tz: 'America/Chicago' })
```

### `unschedule(name)`

Removes all schedules for the queue.

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

An optional third argument takes a `db` to run the removal on, as `schedule()` does: `boss.unschedule('report', 'eu', { db })`.

### `getSchedules(name?, key?, options)`

Returns schedules, sorted by queue name and key. Pass a queue name to read only that queue's schedules, and a key as well to read the one schedule with that key, as an array of at most one. `options.limit` sets the most it returns, from 1 to 100,000, and defaults to 1000. Pass the last schedule as `options.after` to read the next page. Pass the options as the third argument, after the name and key, as `getSchedules(undefined, undefined, { limit: 50 })`.

Each schedule has the expression in `cron`, the format it is in as `kind` (`cron` or `rrule`), the time zone it is evaluated in, and the `data` and `options` its jobs are sent with.

```js
const schedules = await boss.getSchedules()

for (const schedule of schedules) {
  console.log(`${schedule.name} (${schedule.key}): ${schedule.kind} ${schedule.cron} ${schedule.timezone}`)
}
```

Each schedule has the following properties.

| Property | Description |
| --- | --- |
| `name` | Queue the schedule sends into |
| `key` | Unique key within the queue, `''` when none was supplied |
| `kind` | Which format `cron` holds, `cron` or `rrule` |
| `cron` | Cron expression or recurrence rule |
| `timezone` | Time zone the expression is evaluated in, `UTC` when the row never named one |
| `data` | Payload sent with each job |
| `options` | The options `schedule()` was given, which are the `send()` options each job is created with plus `tz`, `key` and `missed` |
| `createdOn` | When the schedule was first stored |
| `updatedOn` | When the definition was last changed |
| `lastJobId` | Id of the job the schedule most recently created |

`lastJobId` connects a schedule to its last run, so you can inspect a queue's history from the
schedule that produced it.

```js
const [schedule] = await boss.getSchedules('report', 'eu')

if (schedule.lastJobId) {
  const [job] = await boss.findJobs('report', { id: schedule.lastJobId })

  // null once the job passes the queue's retention window
  console.log(job?.state)
}
```

`lastJobId` isn't a foreign key. The job it names falls under the queue's retention policy and is
eventually deleted, so it may no longer exist. Re-running `schedule()` for the same `(name, key)`
updates the definition and leaves `lastJobId` alone. `unschedule()` removes the row entirely.

pg-boss records it on a best-effort basis, in a separate statement after it creates the job, so
`null` doesn't prove a schedule never fired. A schedule that last fired before the upgrade adding
the column reads `null` until its next run, and so does one whose annotating statement failed after
its job was already created. Treat it as a pointer to the last run pg-boss observed. The queue's
job history is the complete record of what actually ran.

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

Returns the next occurrences an expression produces, as an array of `Date`. The expression is a
cron expression or an [RRULE](#rrule-expressions), and `previewSchedule()` tells them apart the
same way `schedule()` does. So you can preview a stored schedule from its `cron` column without
consulting its `kind`. It validates the expression and time zone exactly as `schedule()` does, so
anything it previews can also be stored.

It doesn't query the database or need a started instance.

**Arguments**

- `cron`: string, *required*. A cron expression, or an [RRULE](#rrule-expressions)
- `options`: object

**options**

* **tz**, string, *default: `UTC`*

  Time zone the expression is evaluated in. A `null` or empty zone is read as none given, so
  previewing a stored schedule from its `timezone` column works whatever release wrote the row.

* **from**, Date, *default: database time*

  The point the walk starts from. Every occurrence returned is strictly after it, so passing back
  the last occurrence of one page returns the next page.

  The default is this instance's clock plus the skew cached against the database, the same reading
  the cron pass evaluates against. Only an instance started with `schedule` enabled caches the
  skew. On any other instance, including a proxy running with its default of `schedule: false`, the
  skew is zero and the default is the local clock of the calling process. Pass `from`
  explicitly when the reference point has to be exact.

* **count**, number, *default: 5*

  How many occurrences to return. Must be an integer between 1 and 1000. A finite rule can return
  fewer, and a rule whose last occurrence has passed returns none. `schedule()` refuses to store a
  rule like that, and previewing a stored one is how you find out it has finished.

  Occurrences of a sparse expression are expensive to find, and the walk is synchronous, so it also
  gives up after a second to avoid holding the event loop for as long as the count would take. If
  that happens, ask for fewer and page with `from`.

```js
boss.previewSchedule('0 3 * * *', { tz: 'America/Chicago', count: 3 })

boss.previewSchedule('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', { tz: 'America/Chicago', count: 3 })
```

The result lists the expression's occurrences. A pass runs every `cronMonitorIntervalSeconds` and
sends any occurrence from the preceding 60 seconds, so a job lands at or shortly after each listed
time.

To preview a stored schedule, read it first:

```js
const schedule = await boss.getSchedule('report', 'eu')

if (schedule) {
  const upcoming = boss.previewSchedule(schedule.cron, { tz: schedule.timezone })
}
```
