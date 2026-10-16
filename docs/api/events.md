# Events

Each pg-boss instance is an EventEmitter and emits the events below.

## `error`
pg-boss can emit `error` during internal processing, such as scheduling and maintenance. Always add a listener for it, because of what Node does by default:

> If an EventEmitter does not have at least one listener registered for the 'error' event, and an 'error' event is emitted, the error is thrown, a stack trace is printed, and the Node.js process exits.
>
>Source: [Node.js Events > Error Events](https://nodejs.org/api/events.html#events_error_events)

Add the listener after you create the instance and before you call `start()`:

```js
boss.on('error', error => logger.error(error));
```
## `warning`

pg-boss can emit `warning` events during monitoring and maintenance. The payload has `message` and `data` properties with the details.

```js
boss.on('warning', ({ message, data }) => {
  console.log('pg-boss warning:', message, data);
});
```

### Warning persistence

By default, pg-boss emits warnings as events only. To also keep a history of them in the database, enable the `persistWarnings` option:

```js
const boss = new PgBoss({
  connectionString: 'postgres://...',
  persistWarnings: true
});
```

With it enabled, pg-boss writes warnings to the `warning` table, where you can query them directly or view them in the [pg-boss dashboard](https://www.npmjs.com/package/@pg-boss/dashboard). See [SQL](/sql/warning-table) for the table schema.

pg-boss writes only the types under [Warning Types](#warning-types). It emits [startup and configuration warnings](#startup-and-configuration-warnings) as events only. `listen_notify_unavailable` appears in both tables because its cause decides. pg-boss writes it when a listener fails to start, and only emits it when the backend or adapter has no `LISTEN`.

pg-boss deletes warnings older than 365 days automatically. To keep them for less time, set the `warningRetentionDays` option:

```js
const boss = new PgBoss({
  connectionString: 'postgres://...',
  persistWarnings: true,
  warningRetentionDays: 30  // Auto-delete warnings older than 30 days
});
```

### Warning types

pg-boss writes these warnings to the `warning` table when [`persistWarnings`](#warning-persistence) is enabled.

| Type | Description | Data Properties |
|------|-------------|-----------------|
| `slow_query` | A maintenance query exceeded the slow query threshold | `elapsed` (seconds) |
| `queue_backlog` | A queue has exceeded its warning threshold | `name`, `queuedCount`, `warningQueued` |
| `clock_skew` | The database clock is out of sync with the application server | `seconds`, `direction` |
| `listen_notify_unavailable` | `useListenNotify` is enabled and the `LISTEN/NOTIFY` listener failed to start, for example behind PgBouncer transaction pooling or after a dropped connection. pg-boss continues with polling only. Emitted once per `start()` | `type`, `instance`, `error` |
| `index_bloat` | A job index holds far more pages than its live entries need, and pg-boss didn't rebuild it. Either rebuilds are disabled, the connected role doesn't own the index, the index exceeds `maxIndexBytes`, or `REINDEX CONCURRENTLY` failed, and the message names which. Emitted once per index, and again if the condition clears and comes back | `name`, `table`, `pages`, `entries`, `bytes`, `owned` |
| `xmin_horizon` | Something is holding the database's MVCC transaction horizon back: an open transaction, a replication slot, a standby with `hot_standby_feedback`, or a prepared transaction. Autovacuum then can't reclaim the rows pg-boss deletes, and both tables and indexes grow without bound. It fires when pg-boss measures all three of these: a job table past the point Postgres would vacuum it, a vacuum that has run since and reclaimed nothing, and a holder old enough to explain it (see [`monitorVacuum`](./constructor.md#monitorvacuum)). The message names the holder class and the table it was measured on. Emitted once per episode, and again if the horizon is pinned a second time. Also emitted once per instance, with `instance` and `error`, when the connected role can read none of the horizon sources, which disables the check | `source`, `holder`, `transactions`, `table`, `tables`, `liveTuples`, `deadTuples`, `budget`, `vacuumAgeSeconds`, `oldestTransactionSeconds`, `unreadableSources`, `instance`, `error` |
| `autovacuum_disabled` | A job table has `autovacuum_enabled = false`, holds more dead rows than Postgres's own vacuum point, and is still growing with no vacuum running against it at all (see [`monitorVacuum`](./constructor.md#monitorvacuum)). In `xmin_horizon`, vacuum runs and can't reclaim. Here the fix is autovacuum, and no transaction is stuck, so the warning names no holder. It stays quiet for an operator who vacuums on their own schedule, because each manual vacuum moves the timestamp and drops the count. Emitted once per episode | `table`, `tables`, `liveTuples`, `deadTuples`, `budget`, `vacuumAgeSeconds` |
| `monitor_backoff` | The queue-stats aggregate spent long enough scanning the job table to risk holding autovacuum back, so pg-boss defers the next refresh (see [`monitorVacuum`](./constructor.md#monitorvacuum)). Until then it serves cached counts, including to `getQueueStats({ force: true })`, and `capturedOn` tells you how old they are. Job expiry and heartbeat failure are unaffected. To fix it, shrink the job table (retention, `deleteAfterSeconds`) or partition its busiest queues | `elapsedSeconds`, `naptimeSeconds`, `backoffSeconds`, `backoffUntil` |
| `handler_overrun` | A [`work()`](./workers.md#work-name-options-handler) handler ran past `expireInSeconds` and was still running after pg-boss failed its batch and aborted its signals. Its worker fetches nothing until the handler returns, or until [`offWork()`](./workers.md#offwork-name-options) or [`stop()`](./ops.md#stop-options) stops the worker. Neither waits for the handler. Emitted once per batch, and written to the `warning` table once per queue per hour (see below) | `type`, `instance`, `queue`, `jobs`, `expireInSeconds` |
| `invalid_schedule` | pg-boss couldn't evaluate a stored schedule and skipped it for this cron pass. The cause might be an unusable `timezone`, an empty expression written by an older release, or a recurrence rule on an instance whose release predates rule support. The other schedules are unaffected. Emitted once per broken schedule, and again if the schedule is edited or the instance restarts | `queue`, `key`, `cron`, `timezone` |

pg-boss emits `handler_overrun` once per batch, but a handler that overruns on every job would then write a row per batch. So pg-boss writes the first overrun on a queue at once. After that, each instance counts the queue's overruns and writes one row an hour while they continue. Each row has `count` (the overruns since the previous row), the `since` and `until` of that window, the largest `expireInSeconds` in it, up to 10 of the jobs, and `instance` (the id [`getInstances()`](./ops.md#getinstances-options) reports for the instance that wrote it). An hour with no overrun ends the count, so pg-boss writes the next overrun at once again. `stop()` writes the count so far.

### Startup and configuration warnings

These warnings describe how this instance is set up. Each fires when the instance starts, a worker registers, or a transactional worker first runs. They'd fire again on every restart, so pg-boss emits them as events only and never writes them to the `warning` table. Log them from a `warning` listener at startup.

| Type | Description | Data Properties |
|------|-------------|-----------------|
| `listen_notify_unavailable` | `useListenNotify` is enabled on a backend without `LISTEN/NOTIFY`, such as CockroachDB, or with a `db` adapter that has no `listen`. pg-boss continues with polling only. Emitted once per `start()` | `type`, `backend` |
| `transactional_pool_headroom` | A [`transactional`](./workers.md#work-name-options-handler) worker was registered on a pool with no connections to spare. Each handler in flight holds a connection until it finishes, so at this pool size, fetches, failures and maintenance have no connection left and wait out `connectionTimeoutMillis`. Emitted from `work()`, once per call | `type`, `max`, `transactionalWorkers` |
| `transaction_timeout_probe` | pg-boss asked the server which transaction timeout it recognizes, or did a trial run of the `pg_settings` read it needs to apply one, and the statement failed. Transactional handlers then run with no database-side bound (see [`transactionTimeoutSeconds`](./workers.md#work-name-options-handler)). Every other bound still applies: the handler's own timeout, the rollback deadline and `expireInSeconds`. pg-boss retries the probe a minute later and emits the warning once per process | `type` |
| `start_retry` | [`start({ attempts })`](./ops.md#start-options) failed its first try and will try again. Emitted once per call, not per try | `type`, `attempts`, `error` |

## `wip`

Emitted at most once every 2 seconds whenever at least one worker has an active job. The payload is an array with an entry for each worker in this pg-boss instance.

```js
[
  {
    id: 'fc738fb0-1de5-4947-b138-40d6a790749e',
    workId: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
    name: 'my-queue',
    options: { pollingInterval: 2000 },
    state: 'active',
    count: 1,
    createdOn: 1620149137015,
    lastFetchedOn: 1620149137015,
    lastJobStartedOn: 1620149137015,
    lastJobEndedOn: null,
    lastJobDuration: 343,
    lastError: null,
    lastErrorOn: null
  }
]
```

`workId` is the value `work()` returns. With `localConcurrency`, several worker entries in the array share the same `workId`, so you can match them to the `work()` call that started them.

```js
const workId = await boss.work('my-queue', { localConcurrency: 5 }, handler)

boss.on('wip', workers => {
  const myWorkers = workers.filter(w => w.workId === workId)
  const working = myWorkers.filter(w => w.count > 0).length
  const idle = myWorkers.length - working
  console.log(`working: ${working}/${myWorkers.length}, idle: ${idle}`)
})
```

## `stopped`

Emitted after `stop()`, once every worker has finished its work and maintenance has shut down.

After `stop({ close: false })` this fires while the connection pool is still open. A later `stop()` that closes the pool doesn't emit it again, since workers and maintenance have already shut down.

## `bam`

Emitted when a boss async migration (BAM) command changes status. BAM commands are database operations, such as index builds, that run asynchronously after schema migrations.

```js
boss.on('bam', event => {
  console.log(`BAM ${event.name}: ${event.status}`)
})
```

The event payload contains:

```js
{
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'create-index',
  status: 'completed',  // 'in_progress', 'completed', or 'failed'
  queue: 'my-queue',    // queue name if applicable
  table: 'j1a2b3c4...', // target table name
  error: undefined      // error message if status is 'failed'
}
```

Use it to monitor migration progress in production, or to log it.

## `flow`

The background flow resolver emits it each time it unblocks one or more dependent jobs (created with [`flow()`](./jobs.md#flow-jobs-options)) whose parents have completed. [`flowIntervalSeconds`](./constructor.md#flowintervalseconds) in the constructor options sets how often the resolver runs.

```js
boss.on('flow', event => {
  console.log(`Resolved ${event.resolved} flow job(s) in ${event.table}`)
})
```

The event payload contains:

```js
{
  table: 'job_common',  // partition table the dependents were unblocked in
  resolved: 3           // number of dependent jobs unblocked in this batch
}
```
