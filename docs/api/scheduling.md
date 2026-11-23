# Scheduling

pg-boss can create jobs on a schedule from a cron expression or an [RRULE](#rrule-expressions). As with other cron-based systems, at least one instance must be running for scheduling to work. To keep evaluations down, pg-boss checks schedules every 30 seconds and files each job under the minute its occurrence falls in. A schedule sends at most one job a minute. A job can be created up to one check interval after its occurrence. The exception is a schedule set to `precision: 'second'` whose cron expression names a second other than 0, which sends a job for every occurrence. See [Schedules with second precision](#schedules-with-second-precision).

The 5-placeholder cron format runs on the minute. This expression runs at 3:30 am every day:

```
30 3 * * *
```

The 6-placeholder format adds a seconds field in front. This expression runs at 3:30:30 am every day:

```
30 30 3 * * *
```

Set `cronMonitorIntervalSeconds` to change how often schedules are checked. `cronWorkerIntervalSeconds` is deprecated and has no effect.

A schedule sends jobs only for occurrences after it was stored, or after its expression, time zone or precision last changed. A `* * * * *` schedule stored at 12:00:30 sends its first job for 12:01. Storing the same definition again, as a deployment does on every boot, changes nothing.

To limit clock skew and drift, every 10 minutes each instance compares its clock to the database server's clock. pg-boss stores any skew and uses it as an offset during cron evaluation to keep all instances synchronized. Each schedule records the latest occurrence it has sent, and the statement that sends a job moves that record in the same step. Two instances therefore can't send the same occurrence.

Set `clockMonitorIntervalSeconds` to change the clock monitoring interval. Because cron evaluation reads the time from the instance's [`clock`](./constructor.md#clock) option, a [`TestClock`](./testing.md#controlling-time) can move a schedule to its next occurrence without waiting for it. To turn scheduling off on an instance, pass this in the constructor options.

```js
{
  schedule: false
}
```

For more cron documentation and examples, see the docs for the [cron-parser package](https://www.npmjs.com/package/cron-parser).

## Schedules with second precision

A schedule set to `precision: 'second'` sends a job for every occurrence of a cron expression whose seconds field names a second other than 0, such as `*/5 * * * * *` or `@secondly`. Each occurrence is its own job, created straight on the schedule's queue.

```js
await boss.schedule('heartbeat', '*/5 * * * * *', null, { precision: 'second' })
```

Without the option, a schedule with a seconds field sends at most one job a minute, like any other schedule. The seconds field sets the instant in the minute that its occurrence falls on. An expression whose seconds field is only 0, such as `0 * * * * *`, runs on the minute and is handled like the 5-placeholder format under either precision. A rule is always filed by the minute.

The instance that wins a check holds it for one check interval and evaluates these expressions every second while it does, so a job is normally created within about a second of its occurrence. Two cases wait longer, and neither loses an occurrence:

* A schedule that was just stored is first read at the next check, up to one check interval later, and sends the occurrences since it was stored then.
* When the instance holding the check stops, the next instance takes the check over within one check interval and a second, and sends what came due in between.

Each schedule records the latest occurrence it has sent. The statement that sends an occurrence moves that record past it, which keeps two instances from sending the same occurrence. `unschedule()` and a change from `schedule()` take effect from the next second.

Worth knowing before using one:

* **Intervals restart every minute.** `*/17 * * * * *` runs at :00, :17, :34 and :51, then :00 again.
* **Every occurrence is a job.** `* * * * * *` adds 86,400 jobs a day to its queue. The job's own `singletonKey`, throttling options and the queue's policy apply to each, as they do for `send()`. `singletonNextSlot` is not supported and `schedule()` rejects it.
* **An occurrence that fails to send is retried every second while it is due.** An occurrence that can't be sent for the whole 60-second window is not sent. The schedule is reported with a `warning` event.
* **A rolling upgrade can send an occurrence twice.** An instance on an earlier release files these by the minute, so while both releases run, an occurrence can be sent once by each when the check passes from one to the other. Rolling back to an earlier release can do the same once.

## RRULE expressions

pg-boss reads an expression as a recurrence rule, as defined in [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.10), when it has a `FREQ=` part or a line that opens with an iCalendar property such as `DTSTART` or `RRULE`. [rrule-temporal](https://www.npmjs.com/package/rrule-temporal) evaluates it. Everything else is a cron expression. A cron expression can't be mistaken for a rule, because no cron field contains `=`, `:` or `;`.

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

  When `DTSTART` names a time zone, as `DTSTART;TZID=Europe/Berlin:20260901T090000` does, the rule uses it. Otherwise the `tz` option sets the zone. With `tz: 'America/Chicago'`, `FREQ=DAILY;BYHOUR=9` runs at nine in Chicago through every daylight saving transition.

* **DTSTART**

  A rule with no `DTSTART` is anchored on 1970-01-01T00:00:00 in the schedule's time zone. The anchor is the same in every instance and every release. `FREQ=HOURLY;INTERVAL=6` runs every six hours from midnight on the epoch, because an `INTERVAL` counts from that anchor. Supply a `DTSTART` to choose the phase yourself. pg-boss rejects `COUNT` without a `DTSTART`, since counting from the epoch leaves a rule with nothing left to send.

  An `HOURLY`, `MINUTELY` or `SECONDLY` `INTERVAL` counts elapsed time instead of clock time. Because the epoch anchor falls in standard time, the local time of those occurrences moves with the offset in a zone that observes daylight saving. `FREQ=HOURLY;INTERVAL=6` with `tz: 'America/Chicago'` lands on 00:00, 06:00, 12:00 and 18:00 in January and on 01:00, 07:00, 13:00 and 19:00 in July. To pin the hours to the clock, name them. `FREQ=DAILY;BYHOUR=0,6,12,18` holds across a transition, as `0 */6 * * *` does.

* **Finite rules**

  pg-boss honors `UNTIL` and `COUNT`. Once the last occurrence has passed, the schedule stays in the table and sends nothing more. `schedule()` rejects a rule that has nothing left to send instead of storing it, since a schedule that quietly does nothing is a failure nobody sees.

* **Resolution**

  pg-boss checks schedules every 30 seconds and files a job under the minute its occurrence falls in. A rule finer than a minute, such as `FREQ=SECONDLY` or a `BYSECOND` list, sends one job for each minute that holds an occurrence. Only a cron expression with a seconds field, on a schedule set to `precision: 'second'`, is [evaluated every second](#schedules-with-second-precision). Two occurrences in separate minutes both send, no matter how close together they are. For example, an `RDATE` seconds before one of an hourly rule's own occurrences produces two jobs.

* **Stored format**

  `schedule()` works out which format an expression is in once and stores the answer in the schedule table's `kind` column (`cron` or `rrule`). `getSchedules()` returns that column. Validation and later passes can't read the format differently, because every pass reads the expression the way the column says. A row written straight into the table with SQL has to name its own kind, because the column defaults to `cron` (the format of every schedule stored before rules existed).

  The column is only a hint. When an expression can't be read the way the column says but is written in the other format, the pass reads it as written and corrects the column. So a row that lost its label keeps firing. The label can be lost to a schema rollback and re-upgrade, or to an upsert from an instance whose release predates the column.

Any instance on a release that supports rules can read a rule. During a rolling upgrade, an instance still on an older release reads the expression as cron, can't parse it, and reports an [`invalid_schedule`](./events.md#warning) warning until the instance is replaced. Add rule schedules once the deployment is upgraded.

`schedule()` validates the expression. A rule that would be read differently than it was meant is rejected before it reaches the table:

* an unknown part such as `BYHOURS=9`, or an unknown property such as `DTSRAT`, which a parser drops before evaluating the rest
* a value out of range, such as `BYHOUR=25` or the `25` in `BYHOUR=9,25`, which a parser also drops quietly
* a part named twice, such as `BYHOUR=9;BYHOUR=17`, where the second replaces the first rather than widening it
* an expression with no `RRULE` to recur on, such as `DTSTART` and `RDATE` lines on their own
* a second `DTSTART` or `RRULE`
* an `RDATE` or `EXDATE` given as a date where `DTSTART` is a date time, which excludes or adds midnight rather than the occurrence it names
* the combinations RFC 5545 forbids outright, such as `BYMONTHDAY` with a weekly frequency
* a time zone no evaluation can use, which `schedule()` reports in the same words as for a cron schedule

## Catch-up after an outage

A pass sends the occurrences of the preceding 60 seconds. An occurrence that came due while no instance was running a pass isn't sent. A deployment that was down or between deploys for an hour doesn't send what that hour held. The `missed` option sets what a schedule does about missed occurrences.

| `missed` | What a schedule sends for a gap |
| --- | --- |
| `skip` | Nothing. The default |
| `once` | One job, for the most recent occurrence since the gap opened, however many were missed |

```js
// a nightly report reads the current state of the world, so three missed nights are one report
await boss.schedule('report', '0 3 * * *', null, { missed: 'once' })
```

The gap runs from the last time any instance ran a cron pass to the moment the due window opens. pg-boss records the time of that last pass on its version row. Passes run every `cronMonitorIntervalSeconds` (30 by default, 45 at the ceiling) against a 60-second window. A deployment that keeps running has no gap, which means the option costs it nothing. A gap opens when the passes stop: the deployment is down, in the middle of a deploy, or running with `schedule: false`.

A schedule doesn't catch up on time before its own row was written. A schedule written while nothing was running catches up only from when it was written, because `created_on` bounds the range. Re-running `schedule()` for an existing `(name, key)` leaves that bound where it is. A deployment that registers its schedules on every boot still catches up on the outage it just ended.

The option applies to both formats. A rule is read backwards over the gap the same way a cron expression is.

A [schedule with second precision](#schedules-with-second-precision) treats the 60-second window as part of the gap. Under `skip` it sends nothing for the gap. Under `once` it sends one job, for its latest occurrence. Either way it carries on with the next occurrence. When no pass ran for 60 seconds or less, every occurrence in between is sent.

Consider these before choosing `once`:

* **One job for the whole gap, which looks like any other scheduled job.** The job carries the schedule's `data` unchanged. A handler can't tell that the job is late or which occurrence the job stands for. Three days of downtime sends one job for last night's occurrence and nothing for the two nights before it.

* **It includes the occurrence that is due now.** When an occurrence is due as the gap closes, the one job is for that occurrence.

* **The pass that reads a gap closes it.** If a pass claims a gap and then fails, the next pass doesn't catch up on the occurrences it lost. An instance on a release without catch-up also closes gaps without catching up on them.

## Rolling upgrades

Releases before 12.40 send a schedule's jobs through an internal queue, `__pgboss__send-it`, with a worker on every instance. Later releases insert them directly. While both run, a later instance skips an occurrence an older one has already queued there, and forwards any queued occurrence left behind. It also leaves a completed row there for each occurrence it sends, which keeps an older instance from queuing it again. An upgrade from a release before 12.31.0 can still send an occurrence twice while both run.

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

  An optional time zone name, UTC by default. pg-boss reads a `null` or empty zone as no zone
  chosen, which means UTC. A value threaded out of a config object can be `null` or empty,
  as can a value read back off a schedule row written before zones were validated. `schedule()` rejects an
  unrecognized zone so that a typo can't be stored and then fail on the cron pass.

  When the clocks go back, a cron expression sends a repeated local time once, at its first
  instant, unless it names every hour or multiple minutes across multiple hours. So `30 1 * * *`
  and `0,30 1 * * *` send once that night, `0 * * * *` stays hourly and `*/5 0-3 * * *` keeps
  sending every five minutes through the repeated hour. A schedule can send more that night than
  `previewSchedule()` lists.

  `0,30 1,13 * * *` names multiple minutes across multiple hours, and sends its 01:00 and 01:30
  twice that night. Written as `FREQ=DAILY;BYHOUR=1,13;BYMINUTE=0,30`, it sends each once.

* **key**
  
  An optional unique key, for when the queue needs more than one schedule.

* **missed**

  What the schedule sends for occurrences that came due while no cron pass ran: `skip` (the
  default) or `once`. See [Catch-up after an outage](#catch-up-after-an-outage). A `null` policy
  counts as no policy given, as a `null` zone counts as no zone. `schedule()` rejects any other value.

* **precision**

  `minute` (the default) or `second`. With `second`, a cron expression with a seconds field sends
  a job for every occurrence. See [Schedules with second precision](#schedules-with-second-precision).
  A `null` precision reads as none given; any other value is rejected.

* **db**

  An optional [database adapter](./adapters.md) to run the write on, such as an adapter wrapping a transaction. pg-boss uses it for this call only and doesn't store it with the schedule.


For example, the following call sends a job to the queue `notification-abc` at 3:00am in the US Central time zone.

```js
await boss.schedule('notification-abc', `0 3 * * *`, null, { tz: 'America/Chicago' })
```

### `unschedule(name)`

Removes the queue's schedule that has no key and leaves keyed schedules in place. To remove a keyed schedule, pass its `key`.

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

Returns schedules, sorted by queue name and key. Pass a queue name to read only that queue's schedules. Pass a key as well to read the one schedule with that key, in an array of at most one schedule. `options.limit` sets the most it returns, from 1 to 100,000, and defaults to 1000. Pass the last schedule as `options.after` to read the next page. Pass the options as the third argument, after the name and key, as `getSchedules(undefined, undefined, { limit: 50 })`.

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
| `timezone` | Time zone the expression is evaluated in, `UTC` when the row doesn't name one |
| `data` | Payload sent with each job |
| `options` | The options `schedule()` was given, which are the `send()` options each job is created with plus `tz`, `key`, `missed` and `precision` |
| `createdOn` | When the schedule was first stored |
| `updatedOn` | When the definition was last changed |
| `lastJobId` | Id of the job the schedule most recently created |

`lastJobId` connects a schedule to its last run. Use it to inspect a queue's history from the
schedule that produced it.

```js
const [schedule] = await boss.getSchedules('report', 'eu')

if (schedule.lastJobId) {
  const [job] = await boss.findJobs('report', { id: schedule.lastJobId })

  // null once the job passes the queue's retention window
  console.log(job?.state)
}
```

`lastJobId` isn't a foreign key. The job it names may no longer exist, because the queue's retention policy
eventually deletes it. Re-running `schedule()` for the same `(name, key)`
updates the definition and leaves `lastJobId` alone. `unschedule()` removes the row entirely.

pg-boss records `lastJobId` on a best-effort basis in a separate statement after it creates the
job. A `null` value doesn't prove a schedule hasn't fired. A schedule reads `null` until its next run when
it last fired before the upgrade that added the column, or when its annotating statement failed
after its job was already created. Treat `lastJobId` as a pointer to the last run pg-boss observed. The queue's
job history is the complete record of what actually ran.

### `getSchedule(name, key)`

Returns the schedule for a queue name and unique key, or `null` if there is none. `key` defaults to
the empty string, which is the key `schedule()` uses when no key is supplied.

Unlike `getSchedules(name, key)`, which always returns an array, `getSchedule()` reads the one row a
`(name, key)` pair can have.

```js
const schedule = await boss.getSchedule('report', 'eu')

if (schedule) {
  console.log(`${schedule.cron} ${schedule.timezone}`)
}
```

### `previewSchedule(cron, options)`

Returns the next occurrences an expression produces, as an array of `Date`. The expression is a
cron expression or an [RRULE](#rrule-expressions). `previewSchedule()` tells them apart the same
way `schedule()` does. You can preview a stored schedule from its `cron` column without
consulting its `kind`. It validates the expression and time zone exactly as `schedule()` does, which means
anything it previews can also be stored.

`previewSchedule()` doesn't query the database or need a started instance.

**Arguments**

- `cron`: string, *required*. A cron expression, or an [RRULE](#rrule-expressions)
- `options`: object

**options**

* **tz**, string, *default: `UTC`*

  Time zone the expression is evaluated in. Because a `null` or empty zone is read as no zone given,
  previewing a stored schedule from its `timezone` column works whatever release wrote the row.

* **from**, Date, *default: database time*

  The point the walk starts from. Every occurrence returned is strictly after it. Passing back
  the last occurrence of one page returns the next page.

  The default is this instance's clock plus the skew cached against the database, which is the same
  reading the cron pass evaluates against. Only an instance started with `schedule` enabled caches the
  skew. On any other instance, including a proxy running with its default of `schedule: false`, the
  skew is zero and the default is the local clock of the calling process. Pass `from`
  explicitly when the reference point has to be exact.

* **count**, number, *default: 5*

  How many occurrences to return. Must be an integer between 1 and 1000. A finite rule can return
  fewer and returns none once its last occurrence has passed. Because `schedule()` refuses to store a rule
  like that, previewing a stored rule is how you find out it has finished.

  Occurrences of a sparse expression are expensive to find. The walk is synchronous and gives
  up after a second to avoid holding the event loop for as long as the count would take. If
  the walk gives up, ask for fewer occurrences and page with `from`.

```js
boss.previewSchedule('0 3 * * *', { tz: 'America/Chicago', count: 3 })

boss.previewSchedule('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', { tz: 'America/Chicago', count: 3 })
```

The result lists the expression's occurrences. A job lands at or shortly after each listed time, because a pass runs
every `cronMonitorIntervalSeconds` and sends any occurrence from the preceding 60 seconds.

To preview a stored schedule, read it first:

```js
const schedule = await boss.getSchedule('report', 'eu')

if (schedule) {
  const upcoming = boss.previewSchedule(schedule.cron, { tz: schedule.timezone })
}
```
