# Workers

### `work()`

Adds a new polling worker for a queue and executes the provided callback function when jobs are found. Each call to work() will add a new worker and resolve a unqiue worker id.

Workers can be stopped via `offWork()` all at once by queue name or individually by using the worker id. Worker activity may be monitored by listening to the `wip` event or by polling [`getWipData()`](#getwipdataoptions).

The default options for `work()` is 1 job every 2 seconds.

### `work(name, options, handler)`

**Arguments**
- `name`: string, *required*
- `options`: object
- `handler`: function(jobs): `Promise<any>`, *required*. Takes a second argument, function(jobs, tx), under the `transactional` option below.

**Options**

* **batchSize**, int, *(default=1)*

  Same as in [`fetch()`](./jobs#fetchname-options)

* **includeMetadata**, bool, *(default=false)*

  Same as in [`fetch()`](./jobs#fetchname-options)

* **perJobResults**, bool, *(default=false)*

  Opt in to per-job settlement for batch handlers. By default a batch handler is all-or-nothing: returning completes every job in the batch (and the return value is only stored as `output` when `batchSize` is 1), while throwing fails every job. When `perJobResults` is true, the handler must instead resolve with an array of `JobResult` objects, one per job it processed. pg-boss then settles each job individually, preserving its own output:

  ```js
  await boss.work('resize-image', { batchSize: 10, perJobResults: true }, async (jobs) => {
    return jobs.map(job => {
      try {
        const output = resize(job.data)
        return { id: job.id, status: 'completed', output }
      } catch (err) {
        return err.fatal
          ? { id: job.id, status: 'deadletter', output: err }
          : { id: job.id, status: 'failed', output: err }
      }
    })
  })
  ```

  Each `JobResult` is `{ id, status, output? }` where `id` matches a job from the batch, `status` is `'completed'`, `'failed'`, or `'deadletter'`, and `output` is stored on that job (the completion result, or the failure detail). Notes:

  - **`deadletter`** fails the job terminally and routes it straight to the queue's configured dead letter queue, bypassing any remaining retries (the `output` travels to the dead letter job). If the queue has no dead letter queue configured, the job simply fails terminally, which is equivalent to a `failed` job that has exhausted its retries.
  - Any job in the batch the handler omits from the array is **failed** with a descriptive error so it retries (or dead-letters) per the queue config. A returned result is never assumed.
  - **Throwing** from the handler still fails the entire batch, exactly as without `perJobResults`. Use the returned array to express per-job failures; reserve throwing for batch-wide errors.
  - Resolving with anything other than an array is treated as a contract violation and fails the whole batch.

* **transactional**, bool, *(default=false)*

  Run the handler and the job's completion inside one database transaction. The handler receives a second argument: a `db` for that transaction, with the same `executeSql` interface every pg-boss `db` option takes.

  ```js
  await boss.work('charge-customer', { transactional: true }, async (jobs, tx) => {
    const [job] = jobs

    await tx.executeSql('INSERT INTO ledger (customer, amount) VALUES ($1, $2)', [job.data.customer, job.data.amount])

    // a job created here commits with the ledger row and with this job's completion
    await boss.send('send-receipt', { customer: job.data.customer }, { db: tx })
  })
  ```

  Everything written through `tx` commits with the job's completion, so the handler cannot leave its side effects committed and the job unfinished, or the reverse. On a throw, the writes and the completion roll back together and the job is failed on a pooled connection, so retries and dead lettering behave as they do for any other worker. Nothing else about the job changes: it is claimed before the transaction opens, so `expireInSeconds` bounds it and heartbeats refresh it while the handler runs.

  A commit needs the claim the handler started with. Anything that takes the job away meanwhile rolls the transaction back rather than committing under a job that is about to run again. That covers the expiration, a heartbeat the database stopped seeing, an operator's `cancel()` or `fail()`, another instance's supervisor, and a shutdown that abandons the handler. Settling the job yourself is not that, as long as it goes through `complete()`, `fail()`, `cancel()` or `deleteJob()` with `{ db: tx }`; a raw `UPDATE` of the job table is indistinguishable from a lost claim and is rolled back.

  **Requirements and limits**

  - Needs a database connection pg-boss can open a transaction on: the built-in pool, or a `db` adapter implementing `beginTransaction`. Passing `transactional: true` without one throws from `work()`.
  - Cannot be combined with `perJobResults`: one transaction has a single outcome, so per-job settlement has nothing to commit separately. Rejected rather than silently degraded.
  - **Every handler in flight holds a pool connection for its own duration.** Size `max` above `localConcurrency` (summed over your transactional queues) with room to spare for fetches, failures, and maintenance, or those queries wait out `connectionTimeoutMillis` and reject. pg-boss emits a `warning` at `work()` time when the pool has no room left.
  - **The transaction is open for as long as the handler runs.** A long transaction blocks vacuum from reclaiming dead rows database-wide, so this suits handlers that finish in seconds. For long work, keep the default worker and use the `db` option on `complete()` instead. The database bounds it either way: see `transactionTimeoutSeconds` below.
  - **Some backends cannot carry a transactional worker and heartbeats at once.** The heartbeat writes the claimed row from a pooled connection, and an engine that then refuses the handler's transaction a write to that row (CockroachDB, under serializable isolation) fails the completion. `work()` rejects the combination there rather than shipping a worker that fails every batch; `expireInSeconds` is the liveness bound instead. See [database backends](../database-backends.md#compatibility-flags).
  - **A SQL error the handler catches leaves the transaction aborted.** Postgres then rejects every later statement in it, including the completion pg-boss runs there, so the job fails even though the handler returned. Either let such an error propagate, or isolate the statement behind a `SAVEPOINT` of your own.

* **transactionTimeoutSeconds**, int, *(default=`expireInSeconds` + 5)*

  How long the database gives the handler's transaction before it kills the connection under it. Only valid alongside `transactional`; `0` removes the bound.

  This is not the timer that ends a slow handler. `expireInSeconds` is, and it fires first by design. What this covers is the case no timer inside the process can: the process itself failing under an open transaction (a starved event loop, a driver wedged below the promise). That transaction goes on advertising `backend_xmin` and holding vacuum off every table in the database until something closes it, which is the condition [`monitorVacuum`](./constructor.md#monitorvacuum) reports as an `xmin_horizon` warning.

  ```js
  await boss.work('charge-customer', { transactional: true, transactionTimeoutSeconds: 60 }, handler)
  ```

  The default leaves the handler's own timeout and its rollback the whole window they need, so the server only gives up once neither ran. Applied as `transaction_timeout` where the server has it (PostgreSQL 17+, CockroachDB) and `idle_in_transaction_session_timeout` otherwise, which bounds the gaps between the handler's statements rather than the transaction as a whole. Either way the connection is dropped, so the batch ends on the rolled-back path, and the job is retried under its own retry policy.

  A bound the connection already carries is never widened. Where a role, a managed provider, or a pooler has already set the GUC to something stricter, that value stands and this option cannot raise it. These are the longest transactions pg-boss opens, so they are the last place to relax someone else's limit. If pg-boss cannot ask the server which GUC it recognises, or cannot read the bound the connection already carries from `pg_settings`, it emits a [`transaction_timeout_probe`](./events.md#warning) warning once, runs its batches with no database-side bound, and asks again a minute later.

* **priority**, bool, **deprecated, ignored since 12.30.0**

  Same as in [`fetch()`](./jobs#fetchname-options)

* **orderByCreatedOn**, bool, **deprecated, ignored since 12.30.0**

  Same as in [`fetch()`](./jobs#fetchname-options)

* **minPriority**, int

  Same as in [`fetch()`](./jobs#fetchname-options)

* **maxPriority**, int

  Same as in [`fetch()`](./jobs#fetchname-options)

* **pollingIntervalSeconds**, int, *(default=2)*

  Base interval to check for new jobs, in seconds. Must be >=0.5 (500ms). Used when no faster or slower mode applies: queues without `notify`, or notify-enabled queues when the LISTEN/NOTIFY listener is unavailable.

  > **Note**: When [LISTEN/NOTIFY](#low-latency-dispatch-with-listennotify) is active for a queue, workers are woken the instant a job is created and polling automatically falls back to the slower `notifyPollingIntervalSeconds` backstop, so you don't need to raise `pollingIntervalSeconds` yourself.

* **notifyPollingIntervalSeconds**, int, *(default=30)*

  Polling interval used only while [LISTEN/NOTIFY](#low-latency-dispatch-with-listennotify) is active for the queue (the queue has `notify: true` and the instance listener is established). Since NOTIFY wakes workers immediately, polling only needs to run as a slow safety net, so this can be much larger than `pollingIntervalSeconds`. When notify is off or unavailable, `pollingIntervalSeconds` is used instead. Must be >=0.5 (500ms).

* **burstWhenReadyExceeds**, int

  When the queue's cached `readyCount` (the runnable backlog) exceeds this value, the worker fetches continuously with no delay until it catches up; the first fetch that comes back short ends burst mode. Takes precedence over `notifyPollingIntervalSeconds` and `pollingIntervalSeconds`. Must be an integer >=1.

  > **Note**: `readyCount` is read from the stats cache, so reaction latency is bounded by the instance-level stats pipeline (`monitorIntervalSeconds` / `superviseIntervalSeconds` / `queueCacheIntervalSeconds`).

* **burstWhenBatchFull**, bool, *(default=false)*

  While each fetch returns a full `batchSize` batch there is clearly more work, so the worker keeps fetching continuously with no delay; the first short fetch ends burst mode. Unlike `burstWhenReadyExceeds` this reacts instantly and needs no cached stats. Ignored when `batchSize` is 1 (every successful fetch would otherwise be "full").

* **localConcurrency**, int, *(default=1)*

  Number of workers to spawn for this queue within the current Node.js process. Each worker polls and processes jobs independently, enabling parallel job processing within a single `work()` call.

  > [!NOTE]
  > This is a per-node setting. In a distributed deployment with multiple nodes, each node manages its own workers independently. For example, if you have 3 nodes each calling `work()` with `localConcurrency: 5`, you'll have 15 total workers across your cluster.


  ```js
  // Create 5 workers that can each process jobs in parallel
  await boss.work('email-welcome', { localConcurrency: 5 }, async ([job]) => {
    await sendEmail(job.data)
  })
  ```

* **localGroupConcurrency**, int | object

  Limits how many jobs from the same group can be processed simultaneously **within the current Node.js process**. This is tracked in-memory with no database overhead.

  Can be specified as:
  - A simple number: `localGroupConcurrency: 2` - limits all groups to 2 concurrent jobs per node
  - An object with tier-based limits (see `groupConcurrency` below for format)

  > [!NOTE]
  > This is a per-node limit. In a distributed deployment, each node enforces its own limit independently. Use `groupConcurrency` instead if you need global coordination across nodes.

  ```js
  // Limit each tenant to 2 concurrent jobs on this node (no DB overhead)
  await boss.work('process-data', {
    localConcurrency: 10,
    localGroupConcurrency: 2
  }, async ([job]) => {
    await processData(job.data)
  })
  ```

* **heartbeatRefreshSeconds**, number

  Custom interval in seconds at which the worker sends heartbeats for active jobs. Defaults to `heartbeatSeconds / 2` (derived from the job's heartbeat configuration). Must be strictly less than `heartbeatSeconds`. This is a worker-level setting only. It is not available on queue or job configuration.

  The distinction between `heartbeatSeconds` and `heartbeatRefreshSeconds`:
  - `heartbeatSeconds` (queue/job level) defines the **contract**: how long before a missing heartbeat is considered a failure
  - `heartbeatRefreshSeconds` (worker level) controls the **implementation**: how often the worker sends heartbeats to fulfill that contract

  This option only applies when jobs have `heartbeatSeconds` configured (either on the queue or per-job). Heartbeats are sent automatically by `work()`, so no user action is needed unless a custom refresh interval is desired. When using `fetch()` for manual processing, call `touch()` directly instead.

  ```js
  // Queue configured with 60s heartbeat, worker sends heartbeats every 10s
  await boss.work('video-processing', { heartbeatRefreshSeconds: 10 }, async ([job]) => {
    await processVideo(job.data)
  })
  ```

* **groupConcurrency**, int | object

  Limits how many jobs from the same group can be processed simultaneously **globally across all nodes**. This is enforced via database queries.

  Can be specified as:
  - A simple number: `groupConcurrency: 2` - limits all groups to 2 concurrent jobs globally
  - An object with tier-based limits:
    ```js
    groupConcurrency: {
      default: 1,           // Default limit for groups without a tier
      tiers: {
        enterprise: 5,      // Enterprise tier can have 5 concurrent jobs
        pro: 2              // Pro tier can have 2 concurrent jobs
      }
    }
    ```

  Jobs are assigned to groups using the `group` option in `send()`. Jobs without a group are not limited by groupConcurrency.

  > [!WARNING]
  > The `groupConcurrency` limit is enforced globally across all nodes by tracking active jobs in the database. However, due to the optimistic locking nature of job fetching, there may be brief moments where the limit is slightly exceeded during race conditions when multiple workers fetch jobs simultaneously.

  ```js
  // Limit each tenant to 2 concurrent jobs globally across all nodes
  await boss.work('process-data', {
    localConcurrency: 10,
    groupConcurrency: 2
  }, async ([job]) => {
    await processData(job.data)
  })
  ```

#### Understanding concurrency options

The three concurrency options work together to control job processing at different levels:

| Option | Scope | Tracking | Use case |
| - | - | - | - |
| `localConcurrency` | Per-node | N/A (worker count) | Control total parallel processing capacity per node |
| `localGroupConcurrency` | Per-node, per-group | In-memory | Limit group concurrency without DB overhead |
| `groupConcurrency` | Global, per-group | Database | Coordinate group limits across distributed nodes |

**Key relationships:**

- `localConcurrency` sets the maximum number of jobs a single node can process simultaneously (limited by worker count)
- `localGroupConcurrency` must be ≤ `localConcurrency` (you can't process more jobs from a group than you have workers)
- `groupConcurrency` can exceed `localConcurrency` because it's a global limit across all nodes

**Example: Multi-node deployment**

```js
// 3 nodes, each running:
await boss.work('process-tenant-data', {
  localConcurrency: 5,      // Each node has 5 workers (15 total across cluster)
  groupConcurrency: 10      // Max 10 jobs from same tenant globally
}, handler)
```

In this setup:
- Each node can process up to 5 jobs simultaneously (limited by `localConcurrency`)
- Across all 3 nodes, at most 10 jobs from the same group/tenant can be active (enforced by `groupConcurrency` via DB)
- This ensures predictable load on external resources (APIs, databases) per tenant

**Choosing between `localGroupConcurrency` and `groupConcurrency`:**

- Use `localGroupConcurrency` when you only need per-node fairness and want zero database overhead
- Use `groupConcurrency` when you need strict global limits across a distributed deployment
- You cannot use both simultaneously - choose one based on your requirements

**Handler function**

`handler` should return a promise (Usually this is an `async` function). If the `handler` returns a value or an object, it will be stored in the `output` property. If an unhandled error occurs in a handler, `fail()` will automatically be called for the jobs, storing the error in the `output` property, making the job or jobs available for retry.

> [!TIP]
> By default this is all-or-nothing across the batch. To complete and fail individual jobs within a batch, each with its own `output`, enable the **perJobResults** option above.

The jobs argument is an array of jobs with the following properties.

| Prop | Type | |
| - | - | -|
|`id`| string, uuid |
|`name`| string |
|`data`| object |
|`heartbeatSeconds`| number \| null | Heartbeat interval configured for this job, or null if not configured |
|`signal`| AbortSignal |


An example of a worker that checks for a job every 10 seconds.

```js
await boss.work('email-welcome', { pollingIntervalSeconds: 10 }, ([ job ]) => myEmailService.sendWelcomeEmail(job.data))
```

An example of a worker that returns a maximum of 5 jobs in a batch.

```js
await boss.work('email-welcome', { batchSize: 5 }, (jobs) => myEmailService.sendWelcomeEmails(jobs.map(job => job.data)))
```

### Low-latency dispatch with LISTEN/NOTIFY

By default, workers fetch new jobs by polling on their `pollingIntervalSeconds`, so a freshly created job waits up to one interval before it is picked up. pg-boss can optionally use Postgres [`LISTEN/NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html) to wake workers the instant a job is created, cutting dispatch latency to milliseconds.

This is an **opt-in optimization on top of polling, not a replacement for it.** Polling always keeps running as a safety net, so jobs are never lost if a notification is missed (for example during a brief connection drop). A notification is only ever a hint that tells a worker to fetch now instead of waiting. The normal locking fetch, queue policies, and concurrency limits are unchanged.

**Enabling it requires two opt-ins:**

1. Start the instance with [`useListenNotify: true`](./constructor.md#newoptions). This runs a listener on one dedicated database connection.
2. Mark each queue that should emit notifications with the [`notify: true`](./queues.md#createqueuename-queue) option on `createQueue()` (or `updateQueue()`).

```js
const boss = new PgBoss({ connectionString, useListenNotify: true })
await boss.start()

await boss.createQueue('email-welcome', { notify: true })

// No polling tuning needed. While NOTIFY is active the worker is woken the instant a
// job is created and polls only as a slow backstop (notifyPollingIntervalSeconds, default 30s).
await boss.work('email-welcome', ([ job ]) =>
  myEmailService.sendWelcomeEmail(job.data)
)

// This job is processed almost immediately rather than waiting for the next poll.
await boss.send('email-welcome', { to: 'new@user.com' })
```

**Notes and limitations:**

- Only **immediately-available** jobs emit a notification. Future-dated jobs (`startAfter`, `sendAfter()`, throttling/debouncing) and jobs blocked by [flow](./jobs.md) dependencies are picked up by polling once they become eligible.
- A NOTIFY is emitted transactionally with the insert, so it fires on commit. When you create jobs inside your own transaction via the `db` option, the notification commits atomically with your transaction.
- The listener needs a **session-pinned** connection. It works with the built-in pool and with a `db` adapter that implements `listen`, but **not** through PgBouncer in transaction or statement pooling mode, which disables `LISTEN/NOTIFY`. When a listener cannot be established, pg-boss emits a [`warning`](./events.md#warning) of type `listen_notify_unavailable` and continues polling only.
- The notification channel is namespaced per `schema`, so multiple pg-boss instances (and other services) on the same database do not collide.

### `work(name, handler)`

Simplified work() without an options argument

```js
await boss.work('email-welcome', ([ job ]) => emailer.sendWelcomeEmail(job.data))
```

work() with active job deletion

```js
const queue = 'email-welcome'

await boss.work(queue, async ([ job ]) => {
  await emailer.sendWelcomeEmail(job.data)
  await boss.deleteJob(queue, job.id)
})
```

work() with abort signal

```js
await boss.work('process-video', async ([ job ]) => {
  const result = await fetch('https://api.example.com/process', { signal: job.signal })
})
```

### `getWipData(options)`

Returns a snapshot of all workers in this instance of pg-boss with state `created`, `active`, or `stopping`. This is the same data payload emitted by the `wip` event, but available on-demand without waiting for a job transition.

Use this for continuous monitoring of worker utilization, for example driving metrics or autoscaling signals when jobs are long-running and the `wip` event may not fire frequently enough.

**Arguments**
- `options`: object *(optional)*

**Options**

* **includeInternal**, bool, *(default=false)*

  If true, includes workers for pg-boss internal queues (e.g., scheduling).

**Returns**: `WipData[]`

```js
// Poll worker utilization every 2 seconds for metrics
setInterval(() => {
  const workers = boss.getWipData()
  const working = workers.filter(w => w.state === 'active' && w.count > 0).length
  const idle = workers.filter(w => w.state === 'active' && w.count === 0).length
  console.log(`working: ${working}, idle: ${idle}`)
}, 2000)
```

### `notifyWorker(id)`

Notifies a worker by id to bypass the job polling interval (see `pollingIntervalSeconds`) for this iteration in the loop.

```js
const workerId = await boss.work('email-welcome', { pollingIntervalSeconds: 60 }, handler)

// a job was just created, so tell the worker to fetch now instead of
// waiting out the remainder of its polling interval
await boss.send('email-welcome', { to: 'new@user.com' })
boss.notifyWorker(workerId)
```

### `offWork(name, options)`

Removes a worker by name or id and stops polling.

** Arguments **
- name: string
- options: object

**Options**

* **wait**, boolean, *(default=true)*

  If the promise should wait until current jobs finish

* **id**, string

  Only stop polling by worker id

```js
const workerId = await boss.work('email-welcome', handler)

// stop all workers for a queue, waiting for active jobs to finish
await boss.offWork('email-welcome')

// stop a single worker by id without waiting
await boss.offWork('email-welcome', { id: workerId, wait: false })
```
