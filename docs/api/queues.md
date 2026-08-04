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
| `key_strict_fifo` | Strict FIFO ordering per `singletonKey`. Requires `singletonKey` on every job. Blocks processing of jobs with the same key while any job with that key is active, in retry, or failed. |

> [!WARNING]
> `stately` queues are special in how retries are handled. By definition, stately queues will not allow multiple jobs to occupy `retry` state. Once a job exists in `retry`, failing another `active` job will bypass the retry mechanism and force the job to `failed`. If this job requires retries, consider a custom retry implementation using a dead letter queue.

> [!NOTE]
> `key_strict_fifo` queues enforce strict FIFO (First-In-First-Out) ordering per `singletonKey`. This is useful when you need to ensure jobs for the same entity (e.g., the same order, customer, or resource) are processed sequentially in the order they were created. The queue will block processing of subsequent jobs with the same `singletonKey` while any job with that key is:
> - **active**: currently being processed
> - **retry**: waiting to be retried after a failure
> - **failed**: permanently failed (exhausted all retries)
>
> To unblock a key after a permanent failure, you can either delete the failed job using `deleteJob()` or retry it using `retry()`. Use `getBlockedKeys()` to discover which keys are currently blocked due to failed jobs.

* **partition**, boolean, default false

  If set to true, a dedicated table will be created in the partition scheme. This would be more useful for large queues in order to keep it from being a "noisy neighbor". 

* **deadLetter**, string

  When a job fails after all retries, if the queue has a `deadLetter` property, the job's payload will be copied into that queue, copying the same retention and retry configuration as the original job. The dead-lettered job also records where it came from via the `sourceName`, `sourceId`, `sourceCreatedOn`, and `sourceRetryCount` fields, which power [`redrive()`](jobs#redrivename-options) for moving jobs back to their source queue.

* **warningQueueSize**, int

  How many items can exist in the created or retry state before emitting a warning event.

* **notify**, boolean, default false

  When enabled, creating an immediately-available job on this queue emits a Postgres `NOTIFY` so workers wake right away instead of waiting for their next poll. This only has an effect when the instance is started with the [`useListenNotify`](./constructor.md#newoptions) option, which runs the listener. Jobs scheduled for the future (for example via `sendAfter()` or throttling/debouncing) do **not** emit a notification — they are picked up by polling when they mature. See [Workers › Low-latency dispatch with LISTEN/NOTIFY](./workers.md#low-latency-dispatch-with-listennotify).

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

- **Expiration** (`expireInSeconds`) is the maximum time a job is allowed to remain active. After this period, the job attempt is considered stale — regardless of whether the worker is alive or dead, the attempt has taken too long and is no longer relevant. Set this to the upper bound of how long the job should ever take.

- **Heartbeat** (`heartbeatSeconds`) is a worker liveness check. The worker periodically signals "I'm still alive and working on this job." If the signal stops, it means the worker has died (crash, OOM, network partition, node shutdown) — but the job itself may still be perfectly valid and should be retried on another worker as soon as possible.

| | Heartbeat | Expiration |
| - | - | - |
| **Purpose** | Detect dead workers quickly | Abandon stale job attempts |
| **What it means** | The worker stopped responding — the job is still valid, retry it elsewhere | The job has been active too long — this attempt is no longer relevant |
| **Failure scenario** | Worker crash, OOM kill, network partition, node shutdown | Infinite loop, deadlock, unresponsive external dependency, or simply exceeding the time budget |
| **Detection speed** | Fast (seconds to minutes) | Matches expected job duration |
| **Default** | Disabled | 15 minutes |

Both mechanisms operate independently and can be used together. When a job fails via either mechanism, it follows the same retry logic (`retryLimit`, `retryDelay`, etc.).

**When to use heartbeat:** Long-running jobs where the gap between "worker died" and "job expired" would be unacceptably large. For example, a 2-hour video processing job with `expireInSeconds: 7200` won't be detected as failed until 2 hours after it started, even if the worker crashed immediately. Adding `heartbeatSeconds: 60` means a dead worker is detected within a minute.

**When expiration alone is sufficient:** Only when the expiration time is already short enough that waiting for it to trigger a retry is acceptable. In practice, `expireInSeconds` is set conservatively — well above the typical job duration — to account for slowdowns, rate limiting, and transient issues. The default is 15 minutes. This means even a quick task like sending an email could wait 15 minutes before a dead worker is detected via expiration. Heartbeat closes this gap by detecting the dead worker in seconds, regardless of how long the expiration is set.

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

  Default: 15 minutes.  How many seconds a job may be in active state before being retried or failed. Must be >=1

**Retention options**

* **retentionSeconds**, number

  Default: 14 days. How many seconds a job may be in created or retry state before it's deleted. Must be >=1

* **deleteAfterSeconds**, int

  Default: 7 days. How long a job should be retained in the database after it's completed. Set to 0 to never delete completed jobs.

* All retry, expiration, and retention options set on the queue will be inheritied for each job, unless they are overridden.

### `updateQueue(name, options)`

Updates options on an existing queue, with the exception of the `policy` and `partition` settings, which cannot be changed.

```js
await boss.updateQueue('email-send', { retryLimit: 5, retryDelay: 120 })
```

### `deleteQueue(name)`

Deletes a queue and all jobs.

```js
await boss.deleteQueue('email-send')
```

### `getQueues(names?)`

Returns all queues, or only the named queues when an array of names is provided.

```js
const queues = await boss.getQueues()

for (const queue of queues) {
  console.log(`${queue.name}: ${queue.queuedCount} queued, ${queue.activeCount} active`)
}
```

### `getQueue(name)`

Returns a queue by name, or `null` if it doesn't exist.

```js
const queue = await boss.getQueue('email-send')

if (!queue) {
  await boss.createQueue('email-send')
}
```

### `getQueueStats(name, options)`

Returns an array of queue-depth snapshots, most recent first. Each snapshot has the queue `name`, a `capturedOn` timestamp, and these counts:

* `queuedCount` — jobs waiting to run, **including** deferred (future-dated) jobs; this drives the queue backlog warning, so dumping a lot of deferred work still trips it
* `deferredCount` — jobs scheduled to start in the future (`startAfter` not yet reached)
* `readyCount` — jobs ready to be processed now (`queuedCount - deferredCount`); the true runnable backlog
* `activeCount` — jobs currently being processed
* `failedCount` — failed jobs still retained in the table (bounded by the queue's retention policy, so this is a rolling count of recent failures rather than an all-time total)
* `totalCount` — all jobs currently stored for the queue

Behavior depends on whether stats are being persisted:

* When [`persistQueueStats`](./constructor.md) is enabled, this returns the recorded time series. `options` filters it: `from` (Date, snapshots at or after), `to` (Date, snapshots at or before), and `limit` (int, default 1000, range 1–100000).

  Over a wide window the raw series can be far larger than `limit`, and returning the newest `limit` rows only shows the most recent slice. To get a representative sample spanning the whole window, downsample into time buckets:

  * `bucketSeconds` (int) — group snapshots into fixed-width buckets this many seconds wide, returning one aggregated snapshot per bucket. Bucket boundaries align to the Unix epoch, so they're stable across calls.
  * `maxDataPoints` (int) — auto-downsample: derive the bucket width so the series fits in roughly this many points (e.g. a chart's pixel width). The window spanned is `from`/`to` when supplied (an explicit x-axis range gives stable buckets even with sparse data), otherwise the data's own earliest/latest timestamps. Ignored when `bucketSeconds` is set — explicit resolution wins.
  * `aggregate` (`'max'` | `'min'` | `'avg'`, default `'max'`) — how each count column is collapsed within a bucket: `'max'` for peak depth (best for backlog alerting), `'min'` for the trough, `'avg'` for the rounded mean. Only applies when `bucketSeconds` or `maxDataPoints` is set.

  `limit` still caps the number of buckets returned, so size the bucket so the bucket count stays within it. The covering index on `queue_stats` plus daily partition pruning keeps these aggregates fast with no extra setup; for sustained high-frequency monitoring over long retention you can layer pre-aggregated rollup tables or point `queue_stats` at a TimescaleDB hypertable with a continuous aggregate.
* When `persistQueueStats` is disabled it returns a single datapoint as a one-element array. By default this is served from the cached counts in the queue table (refreshed every `monitorIntervalSeconds`), so the value can be up to one monitor interval stale. Pass `{ force: true }` to re-count directly from the job table and update the values in the queue table, but even this option is rate-limited to once a minute, so repeated calls using `force` don't always re-aggregate.

```js
// current queue depth (single snapshot when persistQueueStats is disabled)
const [stats] = await boss.getQueueStats('email-send')
console.log(`${stats.readyCount} jobs ready, ${stats.activeCount} active`)

// with persistQueueStats enabled: last 24 hours, downsampled for a 300px-wide chart
const series = await boss.getQueueStats('email-send', {
  from: new Date(Date.now() - 24 * 60 * 60 * 1000),
  to: new Date(),
  maxDataPoints: 300,
  aggregate: 'max'
})
```

### `getBlockedKeys(name)`

Returns an array of `singletonKey` values that are currently blocked due to failed jobs. This is only available for queues with the `key_strict_fifo` policy.

```js
const blockedKeys = await boss.getBlockedKeys('my-queue')
// ['order-123', 'order-456']
```

This is useful for monitoring and alerting on queues that have stalled due to failed jobs. You can then decide to either delete the failed jobs or retry them to unblock processing.