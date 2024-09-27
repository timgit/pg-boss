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

### `updateQueue(name, options)`

Updates options on an existing queue. The policy can be changed, but understand this won't impact existing jobs in flight and will only apply the new policy on new incoming jobs.

### `purgeQueue(name)`

Deletes all queued jobs in a queue.

### `deleteQueue(name)`

Deletes a queue and all jobs from the active job table.  Any jobs in the archive table are retained.

### `getQueues()`

Returns all queues

### `getQueue(name)`

Returns a queue by name

### `getQueueSize(name, options)`

Returns the number of pending jobs in a queue by name.

`options`: Optional, object.

| Prop | Type | Description | Default |
| - | - | - | - |
|`before`| string | count jobs in states before this state | states.active |

As an example, the following options object include active jobs along with created and retry.

```js
{
  before: states.completed
}
```
