# Queues

### `createQueue(name, Queue)`

Creates a queue.

```ts
  type Queue = {
    name: string;
    policy?: QueuePolicy;
    partition?: boolean;
    deadLetter?: string;
    warningQueueSize?: number;
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

> `stately` queues are special in how retries are handled. By definition, stately queues will not allow multiple jobs to occupy `retry` state. Once a job exists in `retry`, failing another `active` job will bypass the retry mechanism and force the job to `failed`. If this job requires retries, consider a custom retry implementation using a dead letter queue.

> `key_strict_fifo` queues enforce strict FIFO (First-In-First-Out) ordering per `singletonKey`. This is useful when you need to ensure jobs for the same entity (e.g., the same order, customer, or resource) are processed sequentially in the order they were created. The queue will block processing of subsequent jobs with the same `singletonKey` while any job with that key is:
> - **active**: currently being processed
> - **retry**: waiting to be retried after a failure
> - **failed**: permanently failed (exhausted all retries)
>
> To unblock a key after a permanent failure, you can either delete the failed job using `deleteJob()` or retry it using `retry()`. Use `getBlockedKeys()` to discover which keys are currently blocked due to failed jobs.

* **partition**, boolean, default false

  If set to true, a dedicated table will be created in the partition scheme. This would be more useful for large queues in order to keep it from being a "noisy neighbor". 

* **deadLetter**, string

  When a job fails after all retries, if the queue has a `deadLetter` property, the job's payload will be copied into that queue, copying the same retention and retry configuration as the original job.

* **warningQueueSize**, int

  How many items can exist in the created or retry state before emitting a warning event.

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

Heartbeat and expiration are two independent failure detection mechanisms that solve different problems:

| | Heartbeat | Expiration |
| - | - | - |
| **Detects** | Crashed/dead workers | Hung/stuck workers |
| **How it works** | Worker periodically updates `heartbeat_on` timestamp; monitor fails the job if no update within `heartbeatSeconds` | Monitor fails the job if it has been in `active` state longer than `expireInSeconds` |
| **Failure scenario** | Worker process crashes, OOM kill, network partition, node shutdown | Worker is alive but stuck in an infinite loop, deadlock, or blocked on an unresponsive external service |
| **Detection speed** | Fast (seconds to minutes) | Slow (typically minutes to hours, matching expected job duration) |
| **Default** | Disabled | 15 minutes |

Both mechanisms operate independently and can be used together. When a job fails via either mechanism, it follows the same retry logic (`retryLimit`, `retryDelay`, etc.).

**When to use heartbeat:** Long-running jobs where you want to detect a dead worker much sooner than the job's expected duration. Without heartbeat, a 2-hour video processing job with `expireInSeconds: 7200` won't be detected as failed until 2 hours after it started, even if the worker crashed immediately.

**When expiration alone is sufficient:** Short-lived jobs (seconds to a few minutes) where the expiration time is already close to the expected duration. Adding heartbeat would provide little benefit.

#### Recommended values

As a general guideline, set `heartbeatSeconds` to roughly 1/10th to 1/4th of `expireInSeconds`, depending on how quickly you need to detect failures:

| Job type | `expireInSeconds` | `heartbeatSeconds` | Detection speed |
| - | - | - | - |
| Quick tasks (email, notifications) | 60 | not needed | Expiration is fast enough |
| Medium tasks (report generation) | 600 (10 min) | 30-60 | ~30-60s |
| Long tasks (video processing, ML) | 7200 (2 hr) | 60-300 | ~1-5 min |
| Very long tasks (data migration) | 86400 (24 hr) | 300-600 | ~5-10 min |

There is no benefit to setting `heartbeatSeconds` lower than the monitor interval (`monitorIntervalSeconds`, default 60s), since the monitor must run to detect stale heartbeats. For faster detection, lower `monitorIntervalSeconds` as well.

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

### `deleteQueue(name)`

Deletes a queue and all jobs.

### `getQueues()`

Returns all queues

### `getQueue(name)`

Returns a queue by name

### `getQueueStats(name)`

Returns the number of jobs in various states in a queue.  The result matches the results from getQueue(), but ignores the cached data and forces the stats to be retrieved immediately.

### `getBlockedKeys(name)`

Returns an array of `singletonKey` values that are currently blocked due to failed jobs. This is only available for queues with the `key_strict_fifo` policy.

```js
const blockedKeys = await boss.getBlockedKeys('my-queue')
// ['order-123', 'order-456']
```

This is useful for monitoring and alerting on queues that have stalled due to failed jobs. You can then decide to either delete the failed jobs or retry them to unblock processing.