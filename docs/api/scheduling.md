# Scheduling

Jobs may be created automatically based on a cron expression. As with other cron-based systems, at least one instance needs to be running for scheduling to work. In order to reduce the amount of evaluations, schedules are checked every 30 seconds, which means the 6-placeholder format should be discouraged in favor of the minute-level precision 5-placeholder format.

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

If needed, the default clock monitoring interval can be adjusted using `clockMonitorIntervalSeconds`. Additionally, to disable scheduling on an instance completely, use the following in the constructor options.

```js
{
  schedule: false
}
```

For more cron documentation and examples see the docs for the [cron-parser package](https://www.npmjs.com/package/cron-parser).

## How occurrences are evaluated

Understanding the pass matters mostly for one question: what happens to an occurrence that falls due while nothing is running.

**One pass per interval, deployment-wide.** A pass is claimed through a timestamp on the `version` table, so whichever instance gets there first runs it and the rest skip. `cronMonitorIntervalSeconds` (default 30, must be between 1 and 45) is how long a claim holds, not a per-instance timer, so adding instances does not add passes.

**A pass fires anything due in the last 60 seconds.** For each schedule it evaluates the expression against database time and sends the job if the most recent occurrence is under 60 seconds old. The 45 second ceiling on `cronMonitorIntervalSeconds` exists to guarantee a pass lands inside that window, so a running deployment cannot step over an occurrence.

**One job per schedule per minute, at most.** A slot is usually visible to more than one pass (a 30 second interval against a 60 second window), so the forwarded job is throttled on the schedule's `(queue, key)` with a 60 second window. This is also the reason 6-placeholder expressions do not deliver second-level precision: whatever the expression says, a schedule cannot produce more than one job a minute.

**Missed occurrences are skipped, not replayed.** There is no catch-up. If no instance runs a pass within 60 seconds of an occurrence, that occurrence is gone, and the next job the schedule produces is its next occurrence rather than the one that was missed. Concretely:

| Gap with no instance running | Result |
| - | - |
| Under 60 seconds | The occurrence still fires. The first pass after startup runs immediately and picks it up. |
| Longer than 60 seconds | Every occurrence more than 60 seconds old is skipped, no matter how many. Nothing is queued to make up for them. |

So a rolling deploy that leaves a sub-minute gap rides through, while a longer outage drops whatever fell inside it. If a schedule must not miss an occurrence, make the job idempotent and have the handler work out what still needs doing, rather than relying on one job per occurrence.

### `schedule(name, cron, data, options)`

Schedules a job to be sent to the specified queue based on a cron expression. If the schedule already exists, it's updated to the new cron expression.

**Arguments**

- `name`: string, *required*
- `cron`: string, *required*
- `data`: object
- `options`: object

`options` supports all properties in `send()` as well as the following additional options.

* **tz**

  An optional time zone name. If not specified, the default is UTC. An unrecognized time zone is
  rejected by `schedule()`, so a typo cannot be stored and then fail on the cron pass.

* **key**
  
  An optional unique key if more than schedule is needed for this queue.


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
  console.log(`${schedule.name} (${schedule.key}): ${schedule.cron} ${schedule.timezone}`)
}
```

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