# Workers

### `work()`

Adds a polling worker to a queue and runs your handler on the jobs it finds. Each call to `work()` adds another worker and resolves its unique worker id.

`offWork()` stops a queue's workers all at once by queue name, or one at a time by worker id. To watch what workers are doing, listen to the `wip` event or poll [`getWipData()`](#getwipdata-options).

By default, a worker fetches 1 job every 2 seconds.

### `work(name, options, handler)`

**Arguments**
- `name`: string, *required*
- `options`: object
- `handler`: function(jobs): `Promise<any>`, *required*. Takes a second argument, function(jobs, tx), under the `transactional` option below.

**Options**

* **batchSize**, int, *(default=1)*

  Same as in [`fetch()`](./jobs#fetch-name-options)

* **includeMetadata**, bool, *(default=false)*

  Same as in [`fetch()`](./jobs#fetch-name-options)

* **perJobResults**, bool, *(default=false)*

  Lets a batch handler complete or fail each job on its own. By default a batch handler is all or nothing. Returning completes every job in the batch, and throwing fails every job. The return value is stored as `output` only when `batchSize` is 1. With `perJobResults` on, the handler resolves with an array of `JobResult` objects instead, one per job it processed, and pg-boss settles each job with its own output:

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

  - **`deadletter`** fails the job for good and sends it straight to the queue's dead letter queue, skipping any retries it has left. The `output` goes with it to the dead letter job. On a queue with no dead letter queue, the job fails for good, the same as a `failed` job with no retries left.
  - A job the handler leaves out of the array is **failed** with an error saying so, and it retries or goes to the dead letter queue as the queue's settings say. pg-boss never assumes a result.
  - **Throwing** from the handler still fails the whole batch, as it does without `perJobResults`. Report a failed job in the returned array, and throw only for an error that affects the whole batch.
  - Resolving with anything other than an array fails the whole batch.

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

  Everything written through `tx` commits with the job's completion, so the handler can't leave its side effects committed and the job unfinished, or the reverse. On a throw, the writes and the completion roll back together, and pg-boss fails the job on a pooled connection, so retries and dead lettering work as they do for any other worker. Nothing else about the job changes. pg-boss claims it before the transaction opens, so `expireInSeconds` bounds it and heartbeats refresh it while the handler runs.

  A commit needs the claim the handler started with. If anything takes the job away meanwhile, the transaction rolls back, because the job is about to run again. That covers the job expiring, a heartbeat the database stopped seeing, an operator's `cancel()` or `fail()`, another instance's supervisor, and a shutdown that abandons the handler. Settling the job yourself is fine, as long as it goes through `complete()`, `fail()`, `cancel()` or `deleteJob()` with `{ db: tx }`. A raw `UPDATE` of the job table looks the same as a lost claim, so it rolls back.

  **Requirements and limits**

  - Needs a database connection pg-boss can open a transaction on: the built-in pool, or a `db` adapter implementing `beginTransaction`. Passing `transactional: true` without one throws from `work()`.
  - Can't be combined with `perJobResults`. One transaction has one outcome, so there is nothing to commit job by job, and `work()` refuses the combination.
  - **Every handler in flight holds a pool connection until it finishes.** Set `max` above `localConcurrency` (summed over your transactional queues), with room to spare for fetches, failures and maintenance. Otherwise those queries wait out `connectionTimeoutMillis` and reject. pg-boss emits a `warning` from `work()` when the pool has no room left.
  - **The transaction stays open for as long as the handler runs.** A long transaction stops vacuum from reclaiming dead rows anywhere in the database, so this suits handlers that finish in seconds. For long work, keep the default worker and use the `db` option on `complete()` instead. The database bounds the transaction either way, as `transactionTimeoutSeconds` below describes.
  - **Some backends can't run a transactional worker with heartbeats.** The heartbeat writes the claimed row from a pooled connection. An engine that then refuses the handler's transaction a write to that row (CockroachDB, under serializable isolation) fails the completion. On those backends `work()` refuses the combination, because the worker would fail every batch, and `expireInSeconds` takes the heartbeat's place as the bound on a stuck handler. See [database backends](../database-backends.md#compatibility-flags).
  - **A SQL error the handler catches leaves the transaction aborted.** Postgres then rejects every later statement in it, including the completion pg-boss runs there, so the job fails even though the handler returned. Either let such an error propagate, or isolate the statement behind a `SAVEPOINT` of your own.

* **transactionTimeoutSeconds**, int, *(default=`expireInSeconds` + 5)*

  How long the database gives the handler's transaction before it kills the connection under it. Only valid alongside `transactional`; `0` removes the bound.

  `expireInSeconds` is the timer that ends a slow handler, and it fires first. This option covers what no timer inside the process can, which is the process itself failing under an open transaction (a starved event loop, or a driver stuck below the promise). Until something closes that transaction, it keeps advertising `backend_xmin` and holds vacuum off every table in the database. [`monitorVacuum`](./constructor.md#monitorvacuum) reports that as an `xmin_horizon` warning.

  ```js
  await boss.work('charge-customer', { transactional: true, transactionTimeoutSeconds: 60 }, handler)
  ```

  The default gives the handler's own timeout and its rollback all the time they need, so the server gives up only once neither has run. pg-boss sets it as `transaction_timeout` where the server has that setting (PostgreSQL 17+, CockroachDB). Elsewhere it sets `idle_in_transaction_session_timeout`, which bounds the gaps between the handler's statements, not the whole transaction. Either way the server drops the connection, the batch rolls back, and the job retries under its own retry policy.

  pg-boss never widens a bound the connection already has. Where a role, a managed provider or a pooler has set the GUC to something stricter, that value stands and this option can't raise it. These are the longest transactions pg-boss opens, so they're the last place to relax someone else's limit. If pg-boss can't ask the server which GUC it recognizes, or can't read the connection's existing bound from `pg_settings`, it emits a [`transaction_timeout_probe`](./events.md#warning) warning once. It then runs its batches with no database-side bound and asks again a minute later.

* **priority**, bool, **deprecated, ignored since 12.30.0**

  Same as in [`fetch()`](./jobs#fetch-name-options)

* **orderByCreatedOn**, bool, **deprecated, ignored since 12.30.0**

  Same as in [`fetch()`](./jobs#fetch-name-options)

* **minPriority**, int

  Same as in [`fetch()`](./jobs#fetch-name-options)

* **maxPriority**, int

  Same as in [`fetch()`](./jobs#fetch-name-options)

* **pollingIntervalSeconds**, int, *(default=2)*

  Base interval to check for new jobs, in seconds. Must be >=0.5 (500ms). Used when no faster or slower mode applies: queues without `notify`, or notify-enabled queues when the LISTEN/NOTIFY listener is unavailable.

  > **Note**: When [LISTEN/NOTIFY](#low-latency-dispatch-with-listen-notify) is active for a queue, workers are woken the instant a job is created and polling automatically falls back to the slower `notifyPollingIntervalSeconds` backstop, so you don't need to raise `pollingIntervalSeconds` yourself.

* **notifyPollingIntervalSeconds**, int, *(default=30)*

  Polling interval used only while [LISTEN/NOTIFY](#low-latency-dispatch-with-listen-notify) is active for the queue (the queue has `notify: true` and the instance listener is established). Since NOTIFY wakes workers immediately, polling only needs to run as a slow safety net, so this can be much larger than `pollingIntervalSeconds`. When notify is off or unavailable, `pollingIntervalSeconds` is used instead. Must be >=0.5 (500ms).

* **burstWhenReadyExceeds**, int

  When the queue's cached `readyCount` (the runnable backlog) exceeds this value, the worker fetches continuously with no delay until it catches up; the first fetch that comes back short ends burst mode. Takes precedence over `notifyPollingIntervalSeconds` and `pollingIntervalSeconds`. Must be an integer >=1.

  > **Note**: `readyCount` is read from the stats cache, so reaction latency is bounded by the instance-level stats pipeline (`monitorIntervalSeconds` / `superviseIntervalSeconds` / `queueCacheIntervalSeconds`).

* **burstWhenBatchFull**, bool, *(default=false)*

  While each fetch returns a full `batchSize` batch, there is more work waiting, so the worker keeps fetching with no delay. The first short fetch ends burst mode. Unlike `burstWhenReadyExceeds`, this reacts at once and needs no cached stats. Ignored when `batchSize` is 1, since every successful fetch would count as full.

* **localConcurrency**, int, *(default=1)*

  Number of workers to start for this queue in the current Node.js process. Each worker polls and processes jobs on its own, so one `work()` call can process jobs in parallel.

  > [!NOTE]
  > This is a per-node setting. In a distributed deployment with multiple nodes, each node manages its own workers independently. For example, if you have 3 nodes each calling `work()` with `localConcurrency: 5`, you'll have 15 total workers across your cluster.


  ```js
  // Create 5 workers that can each process jobs in parallel
  await boss.work('email-welcome', { localConcurrency: 5 }, async ([job]) => {
    await sendEmail(job.data)
  })
  ```

* **localGroupConcurrency**, int | object

  Limits how many jobs from the same group run at once **in the current Node.js process**. pg-boss counts them in memory, with no database queries.

  Set it as either:
  - A number. `localGroupConcurrency: 2` limits every group to 2 concurrent jobs per node.
  - An object with limits by tier, in the format `groupConcurrency` below describes.

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

  This option applies only to jobs with `heartbeatSeconds` set, on the queue or on the job. `work()` sends heartbeats for you, so set this only to change how often. When you process jobs yourself with `fetch()`, call `touch()` instead.

  ```js
  // Queue configured with 60s heartbeat, worker sends heartbeats every 10s
  await boss.work('video-processing', { heartbeatRefreshSeconds: 10 }, async ([job]) => {
    await processVideo(job.data)
  })
  ```

* **groupConcurrency**, int | object

  Limits how many jobs from the same group run at once **across all nodes**. pg-boss enforces it with database queries.

  Set it as either:
  - A number. `groupConcurrency: 2` limits every group to 2 concurrent jobs across all nodes.
  - An object with limits by tier:
    ```js
    groupConcurrency: {
      default: 1,           // Default limit for groups without a tier
      tiers: {
        enterprise: 5,      // Enterprise tier can have 5 concurrent jobs
        pro: 2              // Pro tier can have 2 concurrent jobs
      }
    }
    ```

  The `group` option on `send()` puts a job in a group. `groupConcurrency` doesn't limit jobs without a group.

  > [!WARNING]
  > pg-boss enforces `groupConcurrency` across all nodes by counting active jobs in the database. Fetching uses optimistic locking, though, so when several workers fetch at the same moment, a group can briefly go slightly over its limit.

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
- Each node processes up to 5 jobs at once (`localConcurrency`)
- Across all 3 nodes, at most 10 jobs from the same group or tenant are active at once (`groupConcurrency`, enforced in the database)
- So each tenant puts a predictable load on the APIs and databases its jobs call

**Choosing between `localGroupConcurrency` and `groupConcurrency`:**

- Use `localGroupConcurrency` when fairness on each node is enough and you want no database queries for it
- Use `groupConcurrency` when you need a strict limit across all your nodes
- You can't use both on one worker, so pick one

**Handler function**

`handler` returns a promise, usually by being an `async` function. A value or object it returns is stored in the job's `output` property. If it throws, pg-boss calls `fail()` for its jobs and stores the error in `output`, and the jobs become available for retry.

> [!TIP]
> By default this is all-or-nothing across the batch. To complete and fail individual jobs within a batch, each with its own `output`, enable the **perJobResults** option above.

The jobs argument is an array of jobs with the following properties.

| Prop | Type | |
| - | - | -|
|`id`| string, uuid |
|`name`| string |
|`data`| object |
|`retryCount`| number | How many times this job has been retried, which also identifies the attempt this worker holds |
|`heartbeatSeconds`| number \| null | Heartbeat interval configured for this job, or null if not configured |
|`signal`| AbortSignal | Aborted when the handler runs past `expireInSeconds`, when pg-boss shuts down while it runs, or when a heartbeat finds this job no longer active under this worker's claim |


An example of a worker that checks for a job every 10 seconds.

```js
await boss.work('email-welcome', { pollingIntervalSeconds: 10 }, ([ job ]) => myEmailService.sendWelcomeEmail(job.data))
```

An example of a worker that returns a maximum of 5 jobs in a batch.

```js
await boss.work('email-welcome', { batchSize: 5 }, (jobs) => myEmailService.sendWelcomeEmails(jobs.map(job => job.data)))
```

### Low-latency dispatch with LISTEN/NOTIFY

By default, workers fetch new jobs by polling every `pollingIntervalSeconds`, so a new job waits up to one interval before a worker picks it up. pg-boss can also use Postgres [`LISTEN/NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html) to wake workers the moment a job is created, which cuts the wait to milliseconds.

**It's opt-in, and it runs on top of polling.** Polling keeps running as a safety net, so a missed notification (during a brief connection drop, for example) never loses a job. A notification only tells a worker to fetch now instead of waiting. The locking fetch, queue policies and concurrency limits work as before.

**Enabling it requires two opt-ins:**

1. Start the instance with [`useListenNotify: true`](./constructor.md#uselistennotify). This runs a listener on one dedicated database connection.
2. Mark each queue that should emit notifications with the [`notify: true`](./queues.md#createqueue-name-queue) option on `createQueue()` (or `updateQueue()`).

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

Each job has its own signal. On a queue with `heartbeatSeconds`, a heartbeat that finds a job no longer active under this worker's claim aborts that job's signal. That happens when the job failed after its heartbeat went stale or it expired (it may already be running elsewhere), or when something completed, failed, canceled or deleted it, the handler included. The rest of the batch keeps running. pg-boss discards whatever the handler returns for a job it no longer holds, so stopping early only saves the work. A heartbeat that fails to reach the database aborts nothing.

When a handler runs past `expireInSeconds`, pg-boss fails its batch and aborts every signal in it. Aborting can't stop a handler that ignores its signal, so the worker waits for the handler to return before it fetches again, and emits a [`handler_overrun`](./events.md#warning) warning while it waits. Until that handler actually stops, it counts against `localConcurrency` and `localGroupConcurrency`, and its worker doesn't pick up the job's retry.

A handler that never returns holds its worker until [`offWork()`](#offwork-name-options) or [`stop()`](./ops.md#stop-options) stops the worker. Neither waits for the handler, but its `localGroupConcurrency` slots stay taken until it returns. While the worker waits, [`getWipData()`](#getwipdata-options) shows it as `active` with a `count` of 0, since its jobs have already failed.

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

**Arguments**
- `name`: string
- `options`: object

**Options**

* **wait**, boolean, *(default=true)*

  Whether the promise waits for current jobs to finish. It doesn't wait for a handler that outran its timeout, which keeps running on its own (see [`work(name, handler)`](#work-name-handler)).

* **id**, string

  Stops only the worker with this id.

```js
const workerId = await boss.work('email-welcome', handler)

// stop all workers for a queue, waiting for active jobs to finish
await boss.offWork('email-welcome')

// stop a single worker by id without waiting
await boss.offWork('email-welcome', { id: workerId, wait: false })
```
