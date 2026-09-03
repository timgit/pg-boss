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

Each schedule carries the following properties.

| Property | Description |
| --- | --- |
| `name` | Queue the schedule sends into |
| `key` | Unique key within the queue, `''` when none was supplied |
| `cron` | Cron expression |
| `timezone` | Time zone the expression is evaluated in |
| `data` | Payload sent with each job |
| `options` | `send()` options applied to each job |
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