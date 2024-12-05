# Queues

### `createQueue(name, Queue)`

Creates a queue.

Options: Same retry, expiration and retention as documented above. 

```ts
type Queue = RetryOptions &
             ExpirationOptions & 
             RetentionOptions &
             {
              name: string, 
              policy: QueuePolicy, 
              deadLetter?: string
             }
```

Allowed policy values:

| Policy | Description |
| - | - |
| `standard` | (Default) Supports all standard features such as deferral, priority, and throttling |
| `short` | All standard features, but only allows 1 job to be queued, unlimited active. Can be extended with `singletonKey` |
| `singleton` | All standard features, but only allows 1 job to be active, unlimited queued. Can be extended with `singletonKey` |
| `stately` | Combination of short and singleton: Only allows 1 job per state, queued and/or active. Can be extended with `singletonKey` |

> `stately` queues are special in how retries are handled. By definition, stately queues will not allow multiple jobs to occupy `retry` state. Once a job exists in `retry`, failing another `active` job will bypass the retry mechanism and force the job to `failed`. If this job requires retries, consider a custom retry implementation using a dead letter queue.

* **deadLetter**, string

When a job fails after all retries, if the queue has a `deadLetter` property, the job's payload will be copied into that queue, copying the same retention and retry configuration as the original job.

* **deleteAfterSeconds**, int

  How long to keep jobs after processing.

* Default: 7 days


### `updateQueue(name, options)`

Updates options on an existing queue. The policy can be changed, but understand this won't impact existing jobs in flight and will only apply the new policy on new incoming jobs.

### `deleteQueue(name)`

Deletes a queue and all jobs.

### `getQueues()`

Returns all queues

### `getQueue(name)`

Returns a queue by name

### `getQueueStats(name)`

Returns the number of jobs in various states in a queue.  The result matches the results from getQueue(), but ignores the cached data and forces the stats to be retrieved immediately.