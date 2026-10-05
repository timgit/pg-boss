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
| `stately` | Combination of short and singleton: Only allows 1 job per state, queued and/or active. Can be extended with `singletonKey` |
| `exclusive` | Only allows 1 job to be queued or active. Can be extended with `singletonKey` |
| `key_strict_fifo` | FIFO ordering per `singletonKey`. Requires `singletonKey` on every job. Holds back successors while a job with the same key is active, in retry, or failed without blocking other keys. |

> [!WARNING]
> `stately` queues are special in how retries are handled. By definition, stately queues will not allow multiple jobs to occupy `retry` state. Once a job exists in `retry`, failing another `active` job will bypass the retry mechanism and force the job to `failed`. If this job requires retries, consider a custom retry implementation using a dead letter queue.

> [!NOTE]
> `key_strict_fifo` queues enforce FIFO (First-In-First-Out) ordering per `singletonKey`. This is useful when you need to ensure jobs for the same entity (e.g., the same order, customer, or resource) are processed sequentially. The queue will hold back subsequent jobs with the same `singletonKey` while any job with that key is:
> - **active**: currently being processed
> - **retry**: waiting to be retried after a failure
> - **failed**: permanently failed (exhausted all retries)
>
> Blocking is scoped to the individual key, so jobs with other keys remain fetchable. Priority can order work across keys but cannot reorder jobs within a key. A job that is not currently fetchable is skipped when choosing a key's FIFO head, so a later job can run ahead of it: this covers jobs deferred by `startAfter` and jobs held by an unmet flow dependency. If that later job fails into `retry`, it keeps the key's head position until it completes or permanently fails, even once the earlier job becomes eligible. A job that has started must finish before any sibling runs. Fetch filters such as `minPriority` and `maxPriority` are applied after the head is selected and cannot skip it.
>
> **Fetch cost.** Each fetch selects one head per key across the whole queue before applying priority and the batch limit, so its cost scales with the number of *distinct keys that have queued jobs*, not with `batchSize` and not with the total number of queued jobs. A few keys each holding a long backlog is the cheap case: 200 keys holding 1,000 jobs each means only 200 heads to rank. Many keys holding one job each is the expensive case, because every job is its own head. At 200,000 distinct keys with a single job each, a fetch measures roughly 1s against 0.1s for a `standard` queue over the same rows. If your keys are that numerous and never accumulate a backlog, they are never waiting on each other in the first place, and `standard` might be a better policy.
>
> To unblock a key after a permanent failure, you can either delete the failed job using `deleteJob()` or retry it using `retry()`. Use `getBlockedKeys()` to discover which keys are currently blocked due to failed jobs.

**Options**

* **partition**, boolean, default false

  If set to true, a dedicated table will be created in the partition scheme. This would be more useful for large queues in order to keep it from being a "noisy neighbor": by default every queue's jobs share one table, which a queue that grows large or builds an unexpected backlog can slow down for the others.

  > [!NOTE]
  > pg-boss keeps jobs in one logical `job` table using Postgres's declarative list partitioning, and each queue created with `partition` gets a partition of its own. According to [the Postgres docs](https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-BEST-PRACTICES), a partitioning hierarchy handles thousands of partitions well, so decide how many dedicated tables to use by your own needs. If you outgrow that, consider putting queues in separate schemas.

* **deadLetter**, string

  When a job fails after all retries, if the queue has a `deadLetter` property, the job's payload will be copied into that queue. The copy is a job on the dead letter queue and runs under *that* queue's configuration. Retry, retention, expiration, and heartbeat all come from the dead letter queue, not the original job. What travels with the job is its identity: `priority`, `singletonKey`, and `group`, so ordering weight and group concurrency limits still apply. The dead-lettered job also records where it came from via the `sourceName`, `sourceId`, `sourceCreatedOn`, `sourceRetryCount`, and `sourceOutput` fields, plus `sourceRootId`, the first job in the chain, which survives any number of redrives. See [`redrive()`](jobs#redrive-name-options).

* **warningQueueSize**, int

  How many items can exist in the created or retry state before emitting a warning event.

* **notify**, boolean, default false

  When enabled, creating an immediately-available job on this queue emits a Postgres `NOTIFY` so workers wake right away instead of waiting for their next poll. This only has an effect when the instance is started with the [`useListenNotify`](./constructor.md#uselistennotify) option, which runs the listener. Jobs scheduled for the future (for example via `sendAfter()` or throttling/debouncing) do **not** emit a notification. They are picked up by polling when they mature. See [Workers › Low-latency dispatch with LISTEN/NOTIFY](./workers.md#low-latency-dispatch-with-listen-notify).

**Retry options**

* **retryLimit**, int

  Default: 2. Number of retries to complete a job.

* **retryDelay**, int

  Default: 0. Delay between retries of failed jobs, in seconds.

* **retryBackoff**, bool

  Default: false. Enables exponential backoff retries based on retryDelay instead of a fixed delay. Sets initial retryDelay to 1 if not set. A simplified function to get the delay between runs is: `retryDelay * 2 ^ retryCount` with some jitter. The full function to determine the backoff delay is `Math.min(retryDelayMax, retryDelay * (2 ** Math.Min(16, retryCount) / 2 + 2 ** Math.Min(16, retryCount) / 2 * Math.random()))`

* **retryDelayMax**, int

  Default: no limit. Maximum delay between retries of failed jobs, in seconds. Only used when retryBackoff is true.

**Heartbeat options**

* **heartbeatSeconds**, int

  Default: none (disabled). Expected heartbeat interval in seconds. When set, workers using `work()` will automatically send periodic heartbeats. If no heartbeat is received within this interval, the monitor will fail/retry the job. Must be >= 10. Can be overridden per-job via `send()` options.

#### Heartbeat vs expiration

Heartbeat and expiration are two independent mechanisms that address different failure modes:

- **Expiration** (`expireInSeconds`) is the maximum time a job is allowed to remain active. After this period, the job attempt is considered stale. Whether the worker is alive or dead, the attempt has taken too long and is no longer relevant. Set this to the upper bound of how long the job should ever take.

- **Heartbeat** (`heartbeatSeconds`) is a worker liveness check. The worker periodically signals "I'm still alive and working on this job." If the signal stops, it means the worker has died (crash, OOM, network partition, node shutdown). The job itself may still be perfectly valid, and should be retried on another worker as soon as possible.

| | Heartbeat | Expiration |
| - | - | - |
| **Purpose** | Detect dead workers quickly | Abandon stale job attempts |
| **What it means** | The worker stopped responding, so the job is still valid and should be retried elsewhere | The job has been active too long, so this attempt is no longer relevant |
| **Failure scenario** | Worker crash, OOM kill, network partition, node shutdown | Infinite loop, deadlock, unresponsive external dependency, or simply exceeding the time budget |
| **Detection speed** | Fast (seconds to minutes) | Matches expected job duration |
| **Default** | Disabled | 15 minutes |

Both mechanisms operate independently and can be used together. When a job fails via either mechanism, it follows the same retry logic (`retryLimit`, `retryDelay`, etc.).

A worker that only looked dead (a network partition, a stalled event loop) keeps running its handler after its job is failed this way, so the job can run twice and handlers should be idempotent. What the original worker cannot do is settle the retry: a worker's completion, failure and heartbeat only apply to the attempt it claimed, identified by the job's `retryCount`. Once the job has been retried, the original worker's result is discarded, and a [transactional worker](./workers.md#work-name-options-handler) rolls its writes back. The original worker also finds out: its next heartbeat that reaches the database aborts the job's `signal`, so a handler that listens to it can stop early.

**When to use heartbeat:** Long-running jobs where the gap between "worker died" and "job expired" would be unacceptably large. For example, a 2-hour video processing job with `expireInSeconds: 7200` won't be detected as failed until 2 hours after it started, even if the worker crashed immediately. Adding `heartbeatSeconds: 60` means a dead worker is detected within a minute.

**When expiration alone is sufficient:** Only when the expiration time is already short enough that waiting for it to trigger a retry is acceptable. In practice, `expireInSeconds` is set conservatively, well above the typical job duration, to account for slowdowns, rate limiting, and transient issues. The default is 15 minutes. This means even a quick task like sending an email could wait 15 minutes before a dead worker is detected via expiration. Heartbeat closes this gap by detecting the dead worker in seconds, regardless of how long the expiration is set.

#### Recommended values

Set `expireInSeconds` to the maximum time a job should ever take (accounting for worst-case conditions). Set `heartbeatSeconds` based on how quickly you need to detect a dead worker and retry.

Actual detection time is `heartbeatSeconds` + up to `monitorIntervalSeconds` (default 60s), since the monitor must run to observe a stale heartbeat. There is no benefit to setting `heartbeatSeconds` below `monitorIntervalSeconds`.

| Job type | `expireInSeconds` | `heartbeatSeconds` | Dead worker detected in |
| - | - | - | - |
| Quick tasks (email, notifications) | 900 (default) | 30-60 | ~1-2 min |
| Medium tasks (report generation) | 900-1800 | 30-60 | ~1-2 min |
| Long tasks (video processing, ML) | 7200 (2 hr) | 60-300 | ~2-6 min |
| Very long tasks (data migration) | 86400 (24 hr) | 300-600 | ~6-11 min |

**Expiration options**

* **expireInSeconds**, number

  Default: 15 minutes.  How many seconds a job may be in active state before being retried or failed. Must be >=1 and <= 86400 (24 hours)

**Retention options**

* **retentionSeconds**, number

  Default: 14 days. How many seconds a job may be in created or retry state before it's deleted. Must be >=1

* **deleteAfterSeconds**, int

  Default: 7 days. How long a job should be retained in the database after it's completed. Set to 0 to never delete completed jobs.

  Keep it above a few minutes if you rely on throughput counts. A completed job is counted by the monitor at the first pass at least 10 seconds after it finishes (see [`getQueueStats()`](#getqueuestats-name-options)), and one deleted before then is never counted.

* All retry, expiration, and retention options set on the queue will be inheritied for each job, unless they are overridden.

### `updateQueue(name, options)`

Updates options on an existing queue, with the exception of the `policy` and `partition` settings, which cannot be changed.

```js
await boss.updateQueue('email-send', { retryLimit: 5, retryDelay: 120 })
```

Only the options included in the call are changed. The nullable options `deadLetter`, `retryDelayMax`, and `heartbeatSeconds` are cleared by passing `null`.

```js
await boss.updateQueue('email-send', { deadLetter: null })
```

### `deleteQueue(name)`

Deletes a queue and all jobs.

```js
await boss.deleteQueue('email-send')
```

A queue created with `partition: true` has its own table, and dropping it needs brief exclusive locks on the job tables. `deleteQueue()` takes them without waiting, so it never deadlocks with work in flight: while they are busy it tries again, for about 3 seconds, then rejects with `Queue <name> was not deleted` and leaves the queue as it was.

Other instances find out on their next write to it: `send()`, `insert()`, `upsert()` and `flow()` reject with `Queue <name> does not exist`, as for a queue that was never created, and a job naming it as its `deadLetter` rejects with `Dead letter queue <name> does not exist`.

Inside a transaction passed as `db`, a queue in the shared job table is checked when that transaction commits, with the default partitioned layout: `send()` resolves with an id, and the `COMMIT` fails with a foreign key violation (`23503`). A queue created with `partition: true`, or any queue under `noTablePartitioning` (CockroachDB and YugabyteDB), makes the `send()` itself reject.

A queue deleted and created again elsewhere with a different `partition` setting fails the first write from an instance that cached it, with `relation ... does not exist` or a partition constraint violation, and that instance writes to the new table from the next call.

### `getQueues(names?)`

Returns all queues, or only the named queues when an array of names is provided.

```js
const queues = await boss.getQueues(['email-send'])
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

As counted by a monitor pass, which runs every `monitorIntervalSeconds`. A queued job is exactly one of deferred, blocked or ready, so `queuedCount` is `deferredCount + blockedCount + readyCount`.

* `queuedCount`: jobs waiting to run, **including** deferred jobs and jobs blocked by a [`flow()`](./jobs.md#flow-jobs-options) parent; this drives the queue backlog warning, so dumping a lot of deferred work still trips it
* `deferredCount`: queued jobs scheduled to start in the future (`startAfter` not yet reached), leaving out blocked jobs
* `blockedCount`: queued jobs waiting on a flow parent, whatever their `startAfter` (`getQueues()` and `getQueue()` only)
* `readyCount`: queued jobs ready to be processed now, neither deferred nor blocked; the true runnable backlog
* `activeCount`: jobs currently being processed
* `failedCount`: failed jobs still retained in the table (bounded by the queue's retention policy, so this is a rolling count of recent failures rather than an all-time total)
* `totalCount`: all jobs currently stored for the queue

**Monitor pass fields**

What a monitor pass counted for the queue: three deltas, how many jobs were created, completed and failed in the window since the previous pass, and how long the jobs that finished in that window waited and ran. They are recorded only when [`persistQueueStats`](./constructor.md#persistqueuestats) is enabled on the instances that run monitoring. `getQueueStats()` returns them as `null` when it is disabled on the calling instance, and on snapshots captured before pg-boss 12.35 (the deltas) or 12.36 (the rest). `getQueues()` and `getQueue()` return the latest pass that counted, with the three deltas `0` and the rest `null` until one has.

A delta is not the difference between two snapshots' counts: `failedDelta` is not the change in `failedCount`, which also falls as retention deletes failed jobs.

* `createdDelta`: jobs created
* `completedDelta`: jobs completed
* `failedDelta`: jobs that failed terminally (a job that will be retried has not finished, so it is not included)
* `deltaSeconds`: how many seconds the deltas cover. Monitor passes are not evenly spaced (a deferred or missed pass covers several intervals), so compute a rate as `completedDelta / deltaSeconds * 60`, not by dividing by the bucket width. `null` on the first monitor pass that records a queue's deltas, and wherever the deltas are `null`. A queue that went more than two hours (or two monitor intervals, if that is longer) without its deltas being recorded starts a fresh window rather than reporting the whole gap on one snapshot.
* `deltaOn`: when the interval the deltas cover ends, 10 seconds behind `capturedOn`.
* `waitBins`: how long each job that finished in the deltas' window waited, from when it could first start (the later of when it was created and its `startAfter`) to when a worker started it, as a histogram (see **Wait and run histograms** below). A deferred job, a retry sitting out its backoff, a flow job waiting on its parents, or a cancelled or failed job before `resume()` or `retry()` brings it back is not counted as waiting. A job that failed without ever starting has no wait, so the histogram can hold fewer jobs than `completedDelta + failedDelta`, never more.
* `runBins`: how long the same jobs ran, from start to finish, in the same bins.
* `readyOldestSeconds`: how long the oldest ready job had waited when the pass ran, leaving out deferred and blocked jobs. `0` when none was waiting. A wait is only counted in `waitBins` once its job finishes, so a queue whose workers have stopped records no waits at all; this is the figure that keeps rising.

The deltas are eventually consistent rather than up to the second. A job lands in a delta by the time pg-boss stamped on it, which is the start of the transaction that created or finished it, and that row only becomes visible when the transaction commits. So each window ends 10 seconds behind the pass, and a transaction that commits within 10 seconds of starting is counted in the first pass after its stamp is 10 seconds old. Work done inside a longer transaction, such as a [transactional worker](./workers.md#work-name-options-handler) whose handler runs longer than that, commits after its window was recorded. A later pass then adds it to the snapshot its stamp belongs to, as long as it commits within an hour of starting, or within the queue's `deleteAfterSeconds` or `retentionSeconds` if either is shorter, so a snapshot from the last hour can still rise after it has been returned. It never falls. A job that finishes inside a transaction longer than 10 seconds, which the deltas take in afterwards, is left out of the histograms.

**Wait and run histograms**

`waitBins` and `runBins` are histograms: 48 bins, each counting the jobs whose time fell in its range. The bins are spaced logarithmically, each about 1.4 times as wide as the one before, so they cover everything from under 10 ms to about 23 hours with the same relative precision for fast jobs and slow ones. To read percentiles from them, use [`getQueueStats()`](#getqueuestats-name-options)'s `percentiles` option, or [`addBins()`](./utils.md#addbins-a-b) and [`percentile()`](./utils.md#percentile-bins-p) for a single percentile over a whole window or across several queues.

In `queue_stats` the histograms are stored as the `int[]` columns `wait_bins` and `run_bins`, with `NULL` in a bin no job landed in, so coalesce them when adding them up in SQL.

**Other fields**

* `singletonsActive`: the `singletonKey` of each active job in a `singleton` or `stately` queue, as of the last monitor pass; `null` when there are none
* `table`: the table the queue's jobs are stored in, `job_common` unless the queue is partitioned
* `createdOn`: when the queue was created
* `updatedOn`: when [`updateQueue()`](#updatequeue-name-options) last changed it, or when it was created if it never has

### `getQueue(name)`

Returns a queue by name, with the same fields as [`getQueues()`](#getqueues-names), or `null` if it doesn't exist.

```js
const queue = await boss.getQueue('email-send')

if (!queue) {
  await boss.createQueue('email-send')
}
```

### `getQueueStats(name, options)`

Returns an array of queue-depth snapshots, most recent first. Each holds the queue's counts and monitor pass fields, described under [`getQueues()`](#getqueues-names), and `capturedOn`, when the snapshot was captured, or the start of its bucket when downsampled.

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

Behavior depends on whether stats are being persisted:

* When [`persistQueueStats`](./constructor.md#persistqueuestats) is enabled, this returns the recorded time series, filtered and downsampled by the options below.
* When `persistQueueStats` is disabled it returns a single datapoint as a one-element array. By default this is served from the cached counts in the queue table (refreshed every `monitorIntervalSeconds`), so the value can be up to one monitor interval stale.

**Options**

* **from**, Date

  Only snapshots captured at or after this time. With `persistQueueStats` enabled.

* **to**, Date

  Only snapshots captured at or before this time. With `persistQueueStats` enabled.

* **limit**, int, default 1000

  The most snapshots to return, from 1 to 100000, or the most buckets when downsampling. With `persistQueueStats` enabled.

* **force**, boolean, default false

  With `persistQueueStats` disabled, re-count directly from the job table and update the values in the queue table instead of serving the cache. Even this is rate-limited to once a minute, so repeated calls using `force` don't always re-aggregate.

**Downsampling options**

Over a wide window the raw series can be far larger than `limit`, and returning the newest `limit` rows only shows the most recent slice. To get a representative sample spanning the whole window, downsample into time buckets. With `persistQueueStats` enabled.

* **bucketSeconds**, int

  Group snapshots into fixed-width buckets this many seconds wide, returning one aggregated snapshot per bucket. Bucket boundaries align to the Unix epoch, so they're stable across calls.

* **maxDataPoints**, int

  Auto-downsample by deriving the bucket width so the series fits in roughly this many points (e.g. a chart's pixel width). The window spanned is `from`/`to` when supplied (an explicit x-axis range gives stable buckets even with sparse data), otherwise the data's own earliest/latest timestamps. Ignored when `bucketSeconds` is set, since explicit resolution wins.

* **aggregate**, `'max'` | `'min'` | `'avg'`, default `'max'`

  How each count is collapsed within a bucket, with `'max'` for peak depth (best for backlog alerting), `'min'` for the trough, `'avg'` for the rounded mean. Only applies when `bucketSeconds` or `maxDataPoints` is set.

`aggregate` applies to the counts only. The deltas, `deltaSeconds`, `waitBins` and `runBins` are summed within a bucket, and `readyOldestSeconds` is the largest in it. Counts are bucketed by `capturedOn` and deltas by `deltaOn`, so the two line up with no shifting on your side. As a result, the newest bucket's deltas are `null` until the monitor pass that covers it has run. Deltas whose bucket holds no snapshot are folded into the bucket of the newest snapshot before it, so every bucket returned has real counts.

`limit` still caps the number of buckets returned, so size the bucket to stay within it. The covering index on `queue_stats` and daily partition pruning keep these aggregates fast with no extra setup.

**Percentile options**

Percentiles are read from the [wait and run histograms](#getqueues-names) described under `getQueues()`.

* **percentiles**, array of numbers

  Percents from 1 to 100, such as `[50, 95, 99.9]`, to read from each snapshot's histograms. Each snapshot gets a `percentiles` list: one entry per distinct value, in the order asked, each with `p`, `waitSeconds` and `runSeconds`. Each is the percentile of that snapshot, or of that bucket when downsampled.

Histograms add up, but percentiles don't: averaging the p95 of several snapshots does not give their p95. With `bucketSeconds` or `maxDataPoints`, each bucket's histograms are already added up before its percentiles are read. For a single percentile over a whole window, or across several queues, add their histograms with [`addBins()`](./utils.md#addbins-a-b) and read it with [`percentile()`](./utils.md#percentile-bins-p).

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

### `getBlockedKeys(name)`

Returns an array of `singletonKey` values that are currently blocked due to failed jobs. This is only available for queues with the `key_strict_fifo` policy.

```js
const blockedKeys = await boss.getBlockedKeys('my-queue')
// ['order-123', 'order-456']
```

This is useful for monitoring and alerting on queues that have stalled due to failed jobs. You can then decide to either delete the failed jobs or retry them to unblock processing.
