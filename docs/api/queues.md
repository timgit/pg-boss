# Queues

### `createQueue(name, Queue)`

Creates a queue.

```js
// a basic queue with the default (standard) policy
await boss.createQueue('email-send')

// a queue with retry and dead letter configuration
// (the dead letter queue must exist before it can be referenced)
await boss.createQueue('order-processing-dlq')
await boss.createQueue('order-processing', {
  policy: 'singleton',
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  deadLetter: 'order-processing-dlq'
})
```

```ts
type Queue = {
  name: string;
  policy?: QueuePolicy;
  partition?: boolean;
  deadLetter?: string;
  warningQueueSize?: number;
  notify?: boolean;
} & QueueOptions
```

Allowed policy values:

| Policy | Description |
| - | - |
| `standard` | (Default) Supports all standard features such as deferral, priority, and throttling |
| `short` | Only allows 1 job to be queued, unlimited active. Can be extended with `singletonKey` |
| `singleton` | Only allows 1 job to be active, unlimited queued. Can be extended with `singletonKey` |
| `stately` | Combines short and singleton. Only allows 1 job per state, queued and/or active. Can be extended with `singletonKey` |
| `exclusive` | Only allows 1 job to be queued or active. Can be extended with `singletonKey` |
| `key_strict_fifo` | FIFO ordering per `singletonKey`. Requires `singletonKey` on every job. Holds back successors while a job with the same key is active, in retry, or failed. Other keys aren't blocked. |

> [!WARNING]
> `stately` queues handle retries differently. A stately queue allows only one job in the `retry` state. Once a job is in `retry`, failing another `active` job skips the retry and moves that job straight to `failed`. If that job needs retries, build your own retry with a dead letter queue.

> [!NOTE]
> `key_strict_fifo` queues enforce FIFO (First-In-First-Out) ordering per `singletonKey`. Use it when jobs for the same entity (the same order, customer, or resource, for example) must run one after another. The queue holds back later jobs with the same `singletonKey` while any job with that key is:
> - **active**: currently being processed
> - **retry**: waiting to be retried after a failure
> - **failed**: permanently failed (exhausted all retries)
>
> Blocking is scoped to the individual key, so jobs with other keys remain fetchable. Priority can order work across keys but can't reorder jobs within a key. When pg-boss picks a key's FIFO head, it skips any job that can't be fetched yet, so a later job can run ahead of it. That covers jobs deferred by `startAfter` and jobs held by an unmet flow dependency. If that later job fails into `retry`, it keeps the key's head position until it completes or permanently fails, even once the earlier job becomes eligible. A job that has started must finish before any sibling runs. pg-boss applies fetch filters such as `minPriority` and `maxPriority` after it selects the head, so they can't skip it.
>
> **Fetch cost.** Each fetch selects one head per key across the whole queue before it applies priority and the batch limit. Its cost grows with the number of *distinct keys that have queued jobs*, whatever the `batchSize` or the total number of queued jobs. A few keys each holding a long backlog is the cheap case: 200 keys holding 1,000 jobs each means only 200 heads to rank. Many keys holding one job each is the expensive case, because every job is its own head. At 200,000 distinct keys with a single job each, a fetch takes roughly 1s, against 0.1s for a `standard` queue over the same rows. If your keys are that numerous and never build up a backlog, their jobs never wait on each other, and `standard` might be a better policy.
>
> To unblock a key after a permanent failure, delete the failed job with `deleteJob()` or retry it with `retry()`. `getBlockedKeys()` lists the keys that failed jobs are blocking.

**Options**

* **partition**, boolean, default false

  When true, pg-boss creates a dedicated table for the queue in the partition scheme. By default every queue's jobs share one table, and a queue that grows large or builds an unexpected backlog can slow that table down for the others. A dedicated table keeps a large queue from being that "noisy neighbor".

  > [!NOTE]
  > pg-boss keeps jobs in one logical `job` table using Postgres's declarative list partitioning, and each queue created with `partition` gets a partition of its own. According to [the Postgres docs](https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-BEST-PRACTICES), a partitioning hierarchy handles thousands of partitions well, so choose how many dedicated tables to use based on your own needs. If you outgrow that, consider putting queues in separate schemas.

* **deadLetter**, string

  When a job fails after all its retries, pg-boss copies its payload into the queue named here. The copy is a job on the dead letter queue and runs under *that* queue's configuration, so its retry, retention, expiration, and heartbeat settings come from the dead letter queue. It keeps the original job's `priority`, `singletonKey`, and `group`, so ordering weight and group concurrency limits still apply. The dead-lettered job also records where it came from in the `sourceName`, `sourceId`, `sourceCreatedOn`, `sourceRetryCount`, and `sourceOutput` fields, plus `sourceRootId`, the first job in the chain, which survives any number of redrives. See [`redrive()`](jobs#redrive-name-options).

* **warningQueueSize**, int

  How many jobs can be in the created or retry state before pg-boss emits a warning event.

* **notify**, boolean, default false

  When true, creating a job on this queue that can run now emits a Postgres `NOTIFY`, so workers wake right away instead of waiting for their next poll. It has an effect only when the instance starts with the [`useListenNotify`](./constructor.md#uselistennotify) option, which runs the listener. Jobs scheduled for the future (through `sendAfter()` or throttling or debouncing, for example) do **not** emit a notification. Polling picks them up once they're due. See [Workers › Low-latency dispatch with LISTEN/NOTIFY](./workers.md#low-latency-dispatch-with-listen-notify).

**Retry options**

* **retryLimit**, int

  Default: 2. How many times pg-boss retries a failed job.

* **retryDelay**, int

  Default: 0. Delay between retries of failed jobs, in seconds.

* **retryBackoff**, bool

  Default: false. Uses exponential backoff based on `retryDelay` instead of a fixed delay, and sets `retryDelay` to 1 when it isn't set. Roughly, the delay between runs is `retryDelay * 2 ^ retryCount` with some jitter. The exact backoff delay is `Math.min(retryDelayMax, retryDelay * (2 ** Math.Min(16, retryCount) / 2 + 2 ** Math.Min(16, retryCount) / 2 * Math.random()))`

* **retryDelayMax**, int

  Default: no limit. Maximum delay between retries of failed jobs, in seconds. Used only when `retryBackoff` is true.

**Heartbeat options**

* **heartbeatSeconds**, int

  Default: none (disabled). Expected heartbeat interval in seconds. When it's set, `work()` workers send heartbeats on their own. If no heartbeat arrives within this interval, the monitor fails or retries the job. Must be >= 10. Override it per job with the `send()` options.

#### Heartbeat vs expiration

Heartbeat and expiration are two independent mechanisms that catch different failures:

- **Expiration** (`expireInSeconds`) is the longest a job can stay active. After that, pg-boss treats the attempt as stale. Whether the worker is alive or dead, the attempt has taken too long and is no longer relevant. Set it to the longest the job should ever take.

- **Heartbeat** (`heartbeatSeconds`) is a worker liveness check. The worker periodically signals "I'm still alive and working on this job." If the signal stops, the worker has died (a crash, OOM, network partition or node shutdown). The job itself may still be valid, and should be retried on another worker as soon as possible.

| | Heartbeat | Expiration |
| - | - | - |
| **Purpose** | Detect dead workers quickly | Abandon stale job attempts |
| **What it means** | The worker stopped responding, so the job is still valid and should be retried elsewhere | The job has been active too long, so this attempt is no longer relevant |
| **Failure scenario** | Worker crash, OOM kill, network partition, node shutdown | Infinite loop, deadlock, unresponsive external dependency, or exceeding the time budget |
| **Detection speed** | Fast (seconds to minutes) | Matches expected job duration |
| **Default** | Disabled | 15 minutes |

The two work independently, and you can use both. A job that fails through either one follows the same retry logic (`retryLimit`, `retryDelay`, etc.).

A worker that only looked dead (a network partition, a stalled event loop) keeps running its handler after pg-boss fails its job this way. The job can then run twice, so handlers should be idempotent. The original worker can't settle the retry, because a worker's completion, failure and heartbeat apply only to the attempt it claimed, identified by the job's `retryCount`. Once the job has been retried, pg-boss discards the original worker's result, and a [transactional worker](./workers.md#work-name-options-handler) rolls its writes back. The original worker also finds out, because its next heartbeat that reaches the database aborts the job's `signal`, so a handler that listens to it can stop early.

**When to use heartbeat:** Long-running jobs where the gap between "worker died" and "job expired" would be unacceptably large. For example, with `expireInSeconds: 7200`, pg-boss won't detect that a 2-hour video processing job failed until 2 hours after it started, even if its worker crashed right away. With `heartbeatSeconds: 60`, pg-boss detects a dead worker within a minute.

**When expiration alone is enough:** Only when the expiration time is short enough that you can wait for it to trigger a retry. `expireInSeconds` is usually set well above the typical job duration, to allow for slowdowns, rate limiting, and transient errors. The default is 15 minutes, so even a quick task like sending an email could wait 15 minutes before expiration catches a dead worker. A heartbeat detects the dead worker in seconds, however long the expiration is.

#### Recommended values

Set `expireInSeconds` to the maximum time a job should ever take (allowing for the slowest conditions). Set `heartbeatSeconds` based on how quickly you need to detect a dead worker and retry.

Actual detection time is `heartbeatSeconds` + up to `monitorIntervalSeconds` (default 60s), since the monitor must run to observe a stale heartbeat. Setting `heartbeatSeconds` below `monitorIntervalSeconds` gains nothing.

| Job type | `expireInSeconds` | `heartbeatSeconds` | Dead worker detected in |
| - | - | - | - |
| Quick tasks (email, notifications) | 900 (default) | 30-60 | ~1-2 min |
| Medium tasks (report generation) | 900-1800 | 30-60 | ~1-2 min |
| Long tasks (video processing, ML) | 7200 (2 hr) | 60-300 | ~2-6 min |
| Very long tasks (data migration) | 86400 (24 hr) | 300-600 | ~6-11 min |

**Expiration options**

* **expireInSeconds**, number

  Default: 15 minutes. How many seconds a job can stay active before pg-boss retries or fails it. Must be >=1 and <= 86400 (24 hours)

**Retention options**

* **retentionSeconds**, number

  Default: 14 days. How many seconds a job can stay in the created or retry state before pg-boss deletes it. Must be >=1

* **deleteAfterSeconds**, int

  Default: 7 days. How long pg-boss keeps a completed job in the database. Set to 0 to never delete completed jobs.

  Keep it above a few minutes if you rely on throughput counts. The monitor counts a completed job at its first pass at least 10 seconds after the job finishes (see [`getQueueStats()`](#getqueuestats-name-options)), and never counts one deleted before then.

* Each job inherits the retry, expiration, and retention options set on its queue, unless the job overrides them.

### `updateQueue(name, options)`

Updates options on an existing queue. The `policy` and `partition` settings can't be changed.

```js
await boss.updateQueue('email-send', { retryLimit: 5, retryDelay: 120 })
```

It changes only the options you pass. Pass `null` to clear the nullable options `deadLetter`, `retryDelayMax`, and `heartbeatSeconds`.

```js
await boss.updateQueue('email-send', { deadLetter: null })
```

### `deleteQueue(name)`

Deletes a queue and all its jobs.

```js
await boss.deleteQueue('email-send')
```

For a queue in the shared job table, `deleteQueue()` first deletes its jobs in batches, as [`deleteAllJobs()`](./jobs.md#deletealljobs-name) does, and then deletes the queue. If it fails partway, the jobs already deleted stay deleted and the queue remains. While another queue, or a job in another queue, names it as its dead letter queue, `deleteQueue()` rejects before it deletes anything.

A queue created with `partition: true` has its own table, and dropping it needs brief exclusive locks on the job tables. `deleteQueue()` takes them without waiting, so it never deadlocks with work in flight. While they're busy, it tries again for about 3 seconds, then rejects with `Queue <name> was not deleted` and leaves the queue as it was.

Other instances find out on their next write to the deleted queue. Their `send()`, `insert()`, `upsert()` and `flow()` calls reject with `Queue <name> does not exist`, as for a queue that was never created. A job naming it as its `deadLetter` rejects with `Dead letter queue <name> does not exist`.

Inside a transaction passed as `db`, with the default partitioned layout, the database checks a queue in the shared job table when that transaction commits. So `send()` resolves with an id, and the `COMMIT` fails with a foreign key violation (`23503`). For a queue created with `partition: true`, or any queue under `noTablePartitioning` (CockroachDB), the `send()` itself rejects.

If another instance deletes a queue and creates it again with a different `partition` setting, the first write from an instance that cached the queue fails with `relation ... does not exist` or a partition constraint violation. That instance writes to the new table from its next call.

### `getQueues(names?, options)`

Returns the queues, or only the named queues when an array of names is provided, sorted by name. `options.limit` sets the most it returns, from 1 to 100,000, and defaults to 1000. Pass the last queue's name as `options.after` to read the next page.

```js
const queues = await boss.getQueues(['email-send'])

// The first 50 queues by name
const first = await boss.getQueues(undefined, { limit: 50 })
```

Each queue is a `QueueResult`:

```js
interface QueueResult {
  name: string;
  policy: 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive' | 'key_strict_fifo';
  partition: boolean;
  deadLetter: string | null;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  retryDelayMax: number | null;
  expireInSeconds: number;
  retentionSeconds: number;
  deleteAfterSeconds: number;
  heartbeatSeconds: number | null;
  warningQueueSize: number;
  notify: boolean;
  queuedCount: number;
  deferredCount: number;
  blockedCount: number;
  readyCount: number;
  activeCount: number;
  failedCount: number;
  totalCount: number;
  createdDelta: number;
  completedDelta: number;
  failedDelta: number;
  deltaSeconds: number | null;
  deltaOn: Date | null;
  waitBins: number[] | null;
  runBins: number[] | null;
  readyOldestSeconds: number | null;
  singletonsActive: string[] | null;
  table: string;
  createdOn: Date;
  updatedOn: Date;
}
```

The settings, `policy` through `notify`, are the options described under [`createQueue()`](#createqueue-name-queue), returned as stored.

**Counts**

The monitor updates the counts on each pass, every `monitorIntervalSeconds`. A queued job is exactly one of deferred, blocked or ready, so `queuedCount` is `deferredCount + blockedCount + readyCount`.

* `queuedCount`: jobs waiting to run. The queue backlog warning is based on it
* `deferredCount`: queued jobs whose `startAfter` is in the future
* `blockedCount`: queued jobs waiting on a [`flow()`](./jobs.md#flow-jobs-options) parent (`getQueues()` and `getQueue()` only)
* `readyCount`: queued jobs that can run now
* `activeCount`: jobs currently being processed
* `failedCount`: failed jobs still retained in the table (the queue's retention policy bounds it, so this is a rolling count of recent failures)
* `totalCount`: all jobs currently stored for the queue

`totalCount` is the jobs the monitor pass counts as waiting, active or failed, plus the completed and canceled jobs the maintenance pass counts as it walks the queue. Each monitor pass adds the jobs that finished since, so the total stays current between maintenance passes. A job completed in a transaction that commits more than 10 seconds after it began can be left out until the next maintenance pass. `deleteJob()` and `resume()` immediately subtract the completed and canceled jobs a pass has already counted. When they're passed a `db`, the next maintenance pass corrects the total instead. The other jobs they move show at the next monitor pass. A delete or `resume()` that runs while a monitor or maintenance pass is counting the queue can leave the total off by the jobs it moved until the next maintenance pass. Queued jobs deleted just before a maintenance pass can count again until the next monitor pass. Until a queue's first maintenance pass after upgrading to 12.38, `totalCount` keeps the count it had before the upgrade, less the jobs that deletes remove, or the live jobs if there are more.

**Monitor pass fields**

These fields hold what a monitor pass counted for the queue. Three deltas count the jobs created, completed and failed in the window since the previous pass, and other fields record how long the jobs that finished in that window waited and ran. pg-boss records them only when [`persistQueueStats`](./constructor.md#persistqueuestats) is enabled on the instances that run monitoring. `getQueueStats()` returns them as `null` when it is disabled on the calling instance, and on snapshots captured before pg-boss 12.35 (the deltas) or 12.36 (the rest). `getQueues()` and `getQueue()` return the latest pass that counted, with the three deltas `0` and the rest `null` until one has.

Subtracting two snapshots' counts doesn't give a delta. `failedCount`, for example, also falls as retention deletes failed jobs, so its change differs from `failedDelta`.

* `createdDelta`: jobs created
* `completedDelta`: jobs completed
* `failedDelta`: jobs that failed terminally (a job that will be retried hasn't finished, so it isn't counted)
* `deltaSeconds`: how many seconds the deltas cover. Monitor passes aren't evenly spaced (a deferred or missed pass covers several intervals), so compute a rate as `completedDelta / deltaSeconds * 60` instead of dividing by the bucket width. `null` on the first monitor pass that records a queue's deltas, and wherever the deltas are `null`. When a queue goes more than two hours (or two monitor intervals, if that's longer) without its deltas being recorded, its next window starts fresh, so no single snapshot reports the whole gap.
* `deltaOn`: when the interval the deltas cover ends, 10 seconds behind `capturedOn`.
* `waitBins`: how long each job that finished in the deltas' window waited, from when it could first start (the later of when it was created and its `startAfter`) to when a worker started it, as a histogram (see **Wait and run histograms** below). A deferred job, a retry sitting out its backoff, a flow job waiting on its parents, or a canceled or failed job before `resume()` or `retry()` brings it back isn't counted as waiting. A job that failed without ever starting has no wait, so the histogram can hold fewer jobs than `completedDelta + failedDelta`, never more.
* `runBins`: how long the same jobs ran, from start to finish, in the same bins.
* `readyOldestSeconds`: how long the oldest ready job had waited when the pass ran, leaving out deferred and blocked jobs. `0` when none was waiting. `waitBins` counts a wait only once its job finishes, so a queue whose workers have stopped records no waits at all. `readyOldestSeconds` is the figure that keeps rising.

The deltas are eventually consistent. A job lands in a delta by the time pg-boss stamped on it, which is the start of the transaction that created or finished it. That row becomes visible only when the transaction commits. So each window ends 10 seconds behind the pass, and a transaction that commits within 10 seconds of starting is counted in the first pass after its stamp is 10 seconds old. Work done inside a longer transaction, such as a [transactional worker](./workers.md#work-name-options-handler) whose handler runs longer than that, commits after its window was recorded. A later pass then adds it to the snapshot its stamp belongs to, as long as it commits within an hour of starting (or within the queue's `deleteAfterSeconds` or `retentionSeconds`, if either is shorter). So a snapshot from the last hour can still rise after it has been returned. It never falls. The histograms leave out a job that finishes inside a transaction longer than 10 seconds, even though the deltas take it in afterwards.

**Wait and run histograms**

`waitBins` and `runBins` are histograms: 48 bins, each counting the jobs whose time fell in its range. The bins are spaced logarithmically, each about 1.4 times as wide as the one before, so they cover everything from under 10 ms to about 23 hours with the same relative precision for fast jobs and slow ones. To read percentiles from them, use [`getQueueStats()`](#getqueuestats-name-options)'s `percentiles` option, or [`addBins()`](./utils.md#addbins-a-b) and [`percentile()`](./utils.md#percentile-bins-p) for a single percentile over a whole window or across several queues.

In `queue_stats` the histograms are stored as the `int[]` columns `wait_bins` and `run_bins`, with `NULL` in a bin no job landed in, so coalesce them when adding them up in SQL.

**Other fields**

* `singletonsActive`, **deprecated**: the `singletonKey` of each active job in a `singleton` or `stately` queue, as of the last monitor pass; `null` when there are none. Since 12.37.1 it's informational only, because `fetch()` checks a key's active job directly instead of reading this list. It will be removed in the next major.
* `table`: the table the queue's jobs are stored in, `job_common` unless the queue is partitioned
* `createdOn`: when the queue was created
* `updatedOn`: when [`updateQueue()`](#updatequeue-name-options) last changed it, or when it was created if it never has

### `getQueue(name)`

Returns a queue by name, with the same fields as [`getQueues()`](#getqueues-names-options), or `null` if it doesn't exist.

```js
const queue = await boss.getQueue('email-send')

if (!queue) {
  await boss.createQueue('email-send')
}
```

### `getQueueStats(name, options)`

Returns an array of queue-depth snapshots, most recent first. Each holds the queue's counts and monitor pass fields, described under [`getQueues()`](#getqueues-names-options), plus `capturedOn`. That's when the snapshot was captured, or the start of its bucket when downsampled.

```js
interface QueueStats {
  name: string;
  queuedCount: number;
  deferredCount: number;
  readyCount: number;
  activeCount: number;
  failedCount: number;
  totalCount: number;
  createdDelta: number | null;
  completedDelta: number | null;
  failedDelta: number | null;
  deltaSeconds: number | null;
  deltaOn: Date | null;
  waitBins: number[] | null;
  runBins: number[] | null;
  readyOldestSeconds: number | null;
  percentiles?: { p: number, waitSeconds: number | null, runSeconds: number | null }[];
  capturedOn: Date;
}
```

The result depends on whether stats are persisted:

* When [`persistQueueStats`](./constructor.md#persistqueuestats) is enabled, this returns the recorded time series, filtered and downsampled by the options below.
* When `persistQueueStats` is disabled it returns a single datapoint as a one-element array. By default pg-boss reads it from the cached counts in the queue table (refreshed every `monitorIntervalSeconds`), so the value can be up to one monitor interval stale.

**Options**

* **from**, Date

  Only snapshots captured at or after this time. Applies only with `persistQueueStats` enabled.

* **to**, Date

  Only snapshots captured at or before this time. Applies only with `persistQueueStats` enabled.

* **limit**, int, default 1000

  The most snapshots to return, from 1 to 100000, or the most buckets when downsampling. Applies only with `persistQueueStats` enabled.

* **force**, boolean, default false

  With `persistQueueStats` disabled, counts directly from the job table and updates the values in the queue table instead of reading the cache. This is still limited to once a minute, so repeated calls with `force` don't always count again.

**Downsampling options**

Over a wide window the raw series can be far larger than `limit`, and the newest `limit` rows show only the most recent slice. To sample the whole window evenly, downsample it into time buckets. Applies only with `persistQueueStats` enabled.

* **bucketSeconds**, int

  Groups snapshots into fixed-width buckets this many seconds wide and returns one aggregated snapshot per bucket. Bucket boundaries align to the Unix epoch, so they're stable across calls.

* **maxDataPoints**, int

  Picks a bucket width so the series fits in roughly this many points, such as a chart's pixel width. The window runs from `from` to `to` when you pass them, and an explicit range gives stable buckets even with sparse data. Otherwise it runs from the data's own earliest timestamp to its latest. Ignored when `bucketSeconds` is set, because the explicit width wins.

* **aggregate**, `'max'` | `'min'` | `'avg'`, default `'max'`

  How each count is combined within a bucket. `'max'` gives the peak depth (best for backlog alerting), `'min'` the trough, and `'avg'` the rounded mean. Applies only when `bucketSeconds` or `maxDataPoints` is set.

`aggregate` applies to the counts only. The deltas, `deltaSeconds`, `waitBins` and `runBins` are summed within a bucket, and `readyOldestSeconds` is the largest in it. Counts are bucketed by `capturedOn` and deltas by `deltaOn`, so the two line up with no shifting on your side. As a result, the newest bucket's deltas are `null` until the monitor pass that covers it has run. Deltas whose bucket holds no snapshot are folded into the bucket of the newest snapshot before it, so every bucket returned has real counts.

`limit` still caps the number of buckets returned, so size the bucket to stay within it. The covering index on `queue_stats` and daily partition pruning keep these aggregates fast with no extra setup.

**Percentile options**

Percentiles are read from the [wait and run histograms](#getqueues-names-options) described under `getQueues()`.

* **percentiles**, array of numbers

  The percentiles to read from each snapshot's histograms, as percents from 1 to 100, such as `[50, 95, 99.9]`. Each snapshot gets a `percentiles` list with one entry per distinct value, in the order asked, and each entry has `p`, `waitSeconds` and `runSeconds`. The values are percentiles of that snapshot, or of that bucket when downsampled.

Histograms add up, but percentiles don't. Averaging the p95 of several snapshots doesn't give their p95. With `bucketSeconds` or `maxDataPoints`, each bucket's histograms are already added up before its percentiles are read. For a single percentile over a whole window, or across several queues, add their histograms with [`addBins()`](./utils.md#addbins-a-b) and read it with [`percentile()`](./utils.md#percentile-bins-p).

```js
// current queue depth (single snapshot when persistQueueStats is disabled)
const [stats] = await boss.getQueueStats('email-send')
console.log(`${stats.readyCount} jobs ready, ${stats.activeCount} active`)

// with persistQueueStats enabled: last 24 hours, downsampled for a 300px-wide chart
const series = await boss.getQueueStats('email-send', {
  from: new Date(Date.now() - 24 * 60 * 60 * 1000),
  to: new Date(),
  maxDataPoints: 300,
  aggregate: 'max',
  percentiles: [50, 95] // p50 and p95 wait and run time per bucket
})
// [
//   {
//     name: 'email-send',
//     deferredCount: 0,
//     queuedCount: 0,
//     readyCount: 0,
//     activeCount: 9,
//     failedCount: 0,
//     totalCount: 21148,
//     completedDelta: 179,
//     failedDelta: 0,
//     createdDelta: 178,
//     deltaSeconds: 180,
//     deltaOn: 2026-10-01T19:53:01.805Z,
//     waitBins: [5, 1, 1, 5, 2, 9, 8, 12, 14, 20, 20, 33, 45, 4, 0, … 48 counts],
//     runBins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 35, 43, 40, 47, 0, … 48 counts],
//     readyOldestSeconds: 0,
//     capturedOn: 2026-10-01T19:50:24.000Z,
//     percentiles: [
//       { p: 50, waitSeconds: 0.281, runSeconds: 1.254 },
//       { p: 95, waitSeconds: 0.616, runSeconds: 2.397 }
//     ]
//   },
//   … one per bucket
// ]
```

### `getBlockedKeys(name, options)`

Returns the `singletonKey` values that failed jobs are blocking, as a sorted array. It's available only for queues with the `key_strict_fifo` policy. `options.limit` sets the most it returns, from 1 to 100,000, and defaults to 1000. Pass the last key as `options.after` to read the next page.

```js
const blockedKeys = await boss.getBlockedKeys('my-queue')
// ['order-123', 'order-456']
```

Use it to monitor and alert on queues that failed jobs have stalled. To unblock processing, delete the failed jobs or retry them.
