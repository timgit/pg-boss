# Scheduling

Jobs may be created automatically on a recurring expression. As with other cron-based systems, at least one instance needs to be running for scheduling to work.

Each schedule stores the moment its next occurrence is due. Every 30 seconds, one instance claims the occurrences that have come due and sends their jobs. Claiming the row is what keeps a multi-instance deployment from sending the same occurrence twice, so no throttling is involved and a recurrence kind with finer resolution than a minute is sent as often as its expression says.

To change how often occurrences are claimed, set `cronMonitorIntervalSeconds`. To change how often the claimed jobs are forwarded to their queues, set `cronWorkerIntervalSeconds`.

To mitigate clock skew and drift, every 10 minutes the clock of each instance is compared to the database server's clock. The skew, if any, is stored and used as an offset when occurrences are computed, so all instances agree on when a schedule is due. The default clock monitoring interval can be adjusted with `clockMonitorIntervalSeconds`.

To disable scheduling on an instance completely, use the following in the constructor options.

```js
{
  schedule: false
}
```

## Recurrence kinds

The expression on a schedule is evaluated by a parser, named by its `kind`. `cron` is built in; every other kind is registered on the constructor, in the same way `work()` handlers are registered:

```js
import { RRule } from 'rrule'

const boss = new PgBoss({
  connectionString,
  recurrences: {
    rrule: {
      // The first occurrence strictly after `after`, or null when there is no further occurrence.
      next: (expression, after, tz) => RRule.fromString(expression).after(after),
      // Optional. Throw to reject the expression at schedule() time.
      validate: (expression, tz) => RRule.fromString(expression)
    }
  }
})

await boss.schedule('run-workflow',
  { kind: 'rrule', expression: 'DTSTART;TZID=Europe/Berlin:20260901T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { workflowId },
  { key: workflowId, missed: 'once' }
)
```

Parsers are pure functions that pg-boss calls; they are never stored or serialized. Only the kind and the expression reach the database, so an instance that has no parser for a stored kind leaves those schedules alone and emits a [`warning`](./events.md#warning) of type `unsupported_recurrence`, exactly as a queue with no `work()` handler is simply never fetched. Register the parser on at least one running instance and the schedule resumes.

The expression is stored in the `cron` column whatever the kind, and `getSchedules()` reports it as both `cron` and `expression`.

## Cron expressions

Occurrences are claimed every 30 seconds by default, so the 6-placeholder format should be discouraged in favor of the minute-level precision 5-placeholder format.

For example, use this format, which implies "any second during 3:30 am every day"

```
30 3 * * *
```

but **not** this format which is parsed as "only run exactly at 3:30:30 am every day"

```
30 30 3 * * *
```

For more cron documentation and examples see the docs for the [cron-parser package](https://www.npmjs.com/package/cron-parser).

## Missed occurrences

If no instance is running when an occurrence comes due, the occurrence is missed. Because each schedule stores the occurrence it is waiting on, pg-boss knows exactly which ones were skipped, and the `missed` option decides what to do about them.

* **skip** (default)

  Send nothing for them and resume at the next occurrence. This is how scheduling has always behaved.

* **once**

  Send a single job, no matter how many occurrences were missed. Useful for a job that reconciles state: running it once brings everything up to date.

* **all**

  Send one job per missed occurrence, oldest first. Capped at 1000 per schedule, after which the remainder is dropped and a [`warning`](./events.md#warning) of type `missed_occurrences_capped` is emitted.

An occurrence claimed within 60 seconds of coming due (or twice `cronMonitorIntervalSeconds`, whichever is longer) counts as on time and is sent whatever the policy. A schedule's first occurrence is also always sent, since `schedule()` applies the same window when it anchors the row.

### `schedule(name, cron, data, options)`
### `schedule(name, recurrence, data, options)`

Schedules a job to be sent to the specified queue on a recurring expression. If the schedule already exists, it's updated to the new expression.

**Arguments**

- `name`: string, *required*
- `cron`: string, *required*. A cron expression, or `{ kind, expression }` for a registered recurrence kind
- `data`: object
- `options`: object

`options` supports all properties in `send()` as well as the following additional options.

* **tz**

  An optional time zone name. If not specified, the default is UTC. An unrecognized time zone is
  rejected by `schedule()`, so a typo cannot be stored and then fail on a scheduling pass.

* **key**

  An optional unique key if more than schedule is needed for this queue.

* **missed**

  What to do with occurrences that came due while no instance was running: `skip` (default), `once`, or `all`. See [Missed occurrences](#missed-occurrences).


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

```js
const schedules = await boss.getSchedules()

for (const schedule of schedules) {
  console.log(`${schedule.name} (${schedule.key}): ${schedule.kind} ${schedule.expression} ${schedule.timezone}`)
  console.log(`  last run ${schedule.lastRunAt}, next run ${schedule.nextRunAt}`)
}
```

`nextRunAt` is briefly null while an occurrence is being sent, and null for good once a finite recurrence has no occurrence left.

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
