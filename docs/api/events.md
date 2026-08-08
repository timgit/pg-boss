# Events

Each bun-boss instance is an EventEmitter, and contains the following events.

## `error`
The `error` event could be raised during internal processing, such as scheduling and maintenance. Adding a listener to the error event is strongly encouraged because of the default behavior of the `EventEmitter`.

Database connection failures are not reported here: the built-in driver (Bun's SQL client) exposes no background-error hook, so a broken connection surfaces as a rejection on the operation that encountered it — typically re-emitted as an `error` by the background component that issued the query.

An `error` event with no listener is thrown as an unhandled error. Under Bun it is typically reported on stderr from the async worker loop rather than exiting the process, so an unlistened failure can go unnoticed. Register a listener regardless.

Ideally, code similar to the following example would be used after creating your instance, but before `start()` is called.

```js
boss.on('error', error => logger.error(error));
```

The payload is always an `Error` instance. Errors raised while running a worker additionally carry `queue` (the queue name) and `worker` (the worker id) properties, so a handler can attribute the failure:

```js
boss.on('error', error => logger.error({ queue: error.queue, worker: error.worker }, error));
```
## `warning`

During monitoring and maintenance, bun-boss may raise warning events. The payload contains `message` and `data` properties with details about the warning.

```js
boss.on('warning', ({ message, data }) => {
  console.log('bun-boss warning:', message, data);
});
```

### Warning Types

| Type | Description | Data Properties |
|------|-------------|-----------------|
| `slow_query` | A maintenance query exceeded the slow query threshold | `elapsed` (seconds), `sql`, `values` |
| `queue_backlog` | A queue has exceeded its warning threshold | `name`, `queuedCount`, `warningQueueSize` |
| `clock_skew` | Database clock is out of sync with application server | `seconds`, `direction` |
| `listen_notify_unavailable` | `useListenNotify` is enabled but a `LISTEN/NOTIFY` listener could not be established (an unsupported backend, a `db` adapter without `listen`, or a failed subscribe such as PgBouncer transaction pooling); bun-boss continues with polling only | `type`, and `backend` or `error` depending on the cause |

Only `listen_notify_unavailable` carries its type in `data.type`; the other warnings are identified by their `message` text.

## `wip`

Emitted at most once every 2 seconds whenever at least one worker has an active job. The payload is an array with one entry per active worker in this instance of bun-boss. Workers that have already stopped, and bun-boss's own internal maintenance workers, are excluded.

```ts
const workers = [
  {
    id: 'fc738fb0-1de5-4947-b138-40d6a790749e',
    workId: 'fc738fb0-1de5-4947-b138-40d6a790749e',
    name: 'my-queue',
    options: { pollingInterval: 2000, notifyPollingInterval: 30000 },
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

`workId` is the value returned by `work()`. The first worker of a `work()` call uses that same value as its own `id`, so the two match in the single-worker example above. When using `localConcurrency`, multiple worker entries in the array will share the same `workId`, allowing you to correlate them back to a specific `work()` call.

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

Emitted after `stop()` once all workers have completed their work and maintenance has been shut down.

## `flow`

Emitted by the background flow resolver each time it resolves one or more completed blocking parent jobs, unblocking their dependents (created via [`flow()`](./jobs.md#flowjobs-options)). The `resolved` count is the number of parent jobs cleared in that batch, not the number of dependents that became runnable. See `flowIntervalSeconds` in the [constructor options](./constructor.md) for how often the resolver runs.

```js
boss.on('flow', event => {
  console.log(`Resolved ${event.resolved} blocking parent job(s) in ${event.table}`)
})
```

The event payload contains:

```ts
const event = {
  table: 'job_common',  // partition table whose blocking parents were resolved
  resolved: 1           // completed blocking parent jobs resolved in this batch (their dependents were unblocked)
}
```
