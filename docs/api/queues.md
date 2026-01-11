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

> `stately` queues are special in how retries are handled. By definition, stately queues will not allow multiple jobs to occupy `retry` state. Once a job exists in `retry`, failing another `active` job will bypass the retry mechanism and force the job to `failed`. If this job requires retries, consider a custom retry implementation using a dead letter queue.

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

**Expiration options**

* **expireInSeconds**, number

  Default: 15 minutes.  How many seconds a job may be in active state before being retried or failed. Must be >=1

**Retention options**

* **retentionSeconds**, number

  Default: 14 days. How many seconds a job may be in created or retry state before it's deleted. Must be >=1

* **deleteAfterSeconds**, int

  Default: 7 days. How long a job should be retained in the database after it's completed.

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