# Events

Each bun-boss instance is an EventEmitter, and contains the following events.

## `error`
The `error` event could be raised during internal processing, such as scheduling and maintenance. Adding a listener to the error event is strongly encouraged because of the default behavior of the `EventEmitter`.

Database connection failures are not reported here: the built-in driver (Bun's SQL client) exposes no background-error hook, so a broken connection surfaces as a rejection on the operation that encountered it — typically re-emitted as an `error` by the background component that issued the query.

> If an EventEmitter does not have at least one listener registered for the 'error' event, and an 'error' event is emitted, the error is thrown, a stack trace is printed, and the Node.js process exits.
>
>Source: [Node.js Events > Error Events](https://nodejs.org/api/events.html#events_error_events)

Ideally, code similar to the following example would be used after creating your instance, but before `start()` is called.

```js
boss.on('error', error => logger.error(error));
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

## `wip`

Emitted at most once every 2 seconds whenever at least one worker has an active job. The payload is an array that represents each worker in this instance of bun-boss.

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

`workId` is the value returned by `work()`. When using `localConcurrency`, multiple worker entries in the array will share the same `workId`, allowing you to correlate them back to a specific `work()` call.

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

Emitted by the background flow resolver each time it unblocks one or more dependent jobs (created via [`flow()`](./jobs.md#flowjobs-options)) whose parents have completed. See `flowIntervalSeconds` in the [constructor options](./constructor.md) for how often the resolver runs.

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
