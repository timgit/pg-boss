# Jobs

### `send()`

Creates a new job and returns the job id.

> `send()` will resolve a `null` for job id under some use cases when using unique jobs or throttling (see below).  These options are always opt-in on the send side and therefore don't result in a promise rejection.

### `send(name, data, options)`

**Arguments**

- `name`: string, *required*
- `data`: object
- `options`: object


**General options**

* **priority**, int

  optional priority.  Higher numbers have, um, higher priority

* **id**, uuid

  optional id.  If not set, a uuid will automatically created

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

  Default: 7 days. How long a job should be retained in the database after it's completed. Set to 0 to never delete completed jobs.


All retry, expiration, and retention options can also be set on the queue and will be inheritied for each job, unless they are overridden.
  
**Connection options**

* **db**, object

  Instead of using pg-boss's default adapter, you can use your own, as long as it implements the following interface (the same as the pg module).

    ```ts
    interface Db {
      executeSql(text: string, values: any[]): Promise<{ rows: any[] }>;
  }
    ```

**Deferred jobs**

* **startAfter** int, string, or Date
  * int: seconds to delay starting the job
  * string: Start after a UTC Date time string in 8601 format
  * Date: Start after a Date object

    Default: 0

**Group options**

* **group**, object

  Assigns a job to a group for use with `groupConcurrency` in `work()`. This allows you to limit how many jobs from the same group can be processed simultaneously.

  - **id**, string, *required*: The group identifier (e.g., tenant ID, project ID, customer ID)
  - **tier**, string, *optional*: A tier identifier for tier-based concurrency limits

  ```js
  // Assign job to a tenant group
  await boss.send('process-data', data, {
    group: { id: 'tenant-123' }
  })

  // Assign job to a group with a tier for tier-based limits
  await boss.send('process-data', data, {
    group: { id: 'tenant-456', tier: 'enterprise' }
  })
  ```

**Throttle or debounce jobs**

* **singletonSeconds**, int
* **singletonNextSlot**, bool
* **singletonKey** string

Throttling jobs to 'one per time slot'.  This option is set on the send side of the API since jobs may or may not be created based on the existence of other jobs.

For example, if you set the `singletonSeconds` to 60, then submit 2 jobs within the same minute, only the first job will be accepted and resolve a job id.  The second request will resolve a null instead of a job id.

Setting `singletonNextSlot` to true will cause the job to be scheduled to run after the current time slot if and when a job is throttled. This option is set to true, for example, when calling the convenience function `sendDebounced()`.

As with queue policies, using `singletonKey` will extend throttling to allow one job per key within the time slot.

```js
const payload = {
    email: "billybob@veganplumbing.com",
    name: "Billy Bob"
};

const options =   {
    startAfter: 1,
    retryLimit: 2
};

const jobId = await boss.send('email-send-welcome', payload, options)
console.log(`job ${jobId} submitted`)
```

### `send({ name, data, options })`

This overload supports sending an object with name, data, and options properties.

```js
const jobId = await boss.send({
    name: 'database-backup',
    options: { retryLimit: 1 }
})

console.log(`job ${jobId} submitted`)
```

### `sendAfter(name, data, options, value)`

Send a job that should start after a number of seconds from now, or after a specific date time.

This is a convenience version of `send()` with the `startAfter` option assigned.

`value`: int: seconds | string: ISO date string | Date


### `sendThrottled(name, data, options, seconds, key)`

Only allows one job to be sent to the same queue within a number of seconds.  In this case, the first job within the interval is allowed, and all other jobs within the same interval are rejected.

This is a convenience version of `send()` with the `singletonSeconds` and `singletonKey` option assigned. The `key` argument is optional.

### `sendDebounced(name, data, options, seconds, key)`

Like, `sendThrottled()`, but instead of rejecting if a job is already sent in the current interval, it will try to add the job to the next interval if one hasn't already been sent.

This is a convenience version of `send()` with the `singletonSeconds`, `singletonKey` and `singletonNextSlot` option assigned. The `key` argument is optional.

### `insert(name, Job[], options)`

Create multiple jobs in one request with an array of objects.

The contract and supported features are slightly different than `send()`, which is why this function is named independently. For example, debouncing is not supported, and it doesn't return job IDs unless spies are enabled or `options.returnId` is set to `true`.

The following contract is a typescript defintion of the expected object. This will likely be enhanced later with more support for deferral and retention by an offset. For now, calculate any desired timestamps for these features before insertion.

```ts
interface JobInsert<T = object> {
  id?: string,
  data?: T;
  priority?: number;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  startAfter?: Date | string;
  singletonKey?: string;
  expireInSeconds?: number;
  deleteAfterSeconds?: number;
  keepUntil?: Date | string;
  group?: { id: string; tier?: string };
}
```

### `fetch(name, options)`

Returns an array of jobs from a queue

**Arguments**
- `name`: string
- `options`: object

  * `batchSize`, int, *default: 1*

    Number of jobs to return

  * `priority`, bool, *default: true*

    If true, allow jobs with a higher priority to be fetched before jobs with lower or no priority

  * `orderByCreatedOn`, bool, *default: true*

    If true, jobs are fetched in the order they were created. Set to false to disable this sorting for improved performance when order doesn't matter.

  * `includeMetadata`, bool, *default: false*

    If `true`, all job metadata will be returned on the job object.

  * `ignoreStartAfter`, bool, *default: false*

    If `true`, jobs with a `startAfter` timestamp in the future will be fetched. Useful for fetching jobs immediately without waiting for a retry delay.

    ```js
    interface JobWithMetadata<T = object> {
      id: string;
      name: string;
      data: T;
      priority: number;
      state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
      retryLimit: number;
      retryCount: number;
      retryDelay: number;
      retryBackoff: boolean;
      startAfter: Date;
      startedOn: Date;
      singletonKey: string | null;
      singletonOn: Date | null;
      groupId: string | null;
      groupTier: string | null;
      expireInSeconds: number;
      deleteAfterSeconds: number;
      createdOn: Date;
      completedOn: Date | null;
      keepUntil: Date;
      deadLetter: string,
      policy: string,
      output: object
    }
    ```


**Notes**

The following example shows how to fetch and delete up to 20 jobs.

```js
const QUEUE = 'email-daily-digest'
const emailer = require('./emailer.js')

const jobs = await boss.fetch(QUEUE, { batchSize: 20 })

await Promise.allSettled(jobs.map(async job => {
  try {
    await emailer.send(job.data)
    await boss.deleteJob(QUEUE, job.id)
  } catch(err) {
    await boss.fail(QUEUE, job.id, err)
  }
}))
```

### `deleteJob(name, id, options)`

Deletes a job by id.

> Job deletion is offered if desired for a "fetch then delete" workflow similar to SQS. This is not the default behavior for workers so "everything just works" by default, including job throttling and debouncing, which requires jobs to exist to enforce a unique constraint. For example, if you are debouncing a queue to "only allow 1 job per hour", deleting jobs after processing would re-open that time slot, breaking your throttling policy.

### `deleteJob(name, [ids], options)`

Deletes a set of jobs by id.

### `deleteQueuedJobs(name)`

Deletes all queued jobs in a queue.

### `deleteStoredJobs(name)`

Deletes all jobs in completed, failed, and cancelled state in a queue.

### `deleteAllJobs(name?)`

Deletes all jobs in a queue, including active jobs.

If no queue name is given, jobs are deleted from all queues.


### `cancel(name, id, options)`

Cancels a pending or active job.

### `cancel(name, [ids], options)`

Cancels a set of pending or active jobs.

When passing an array of ids, it's possible that the operation may partially succeed based on the state of individual jobs requested. Consider this a best-effort attempt.

### `resume(name, id, options)`

Resumes a cancelled job.

### `resume(name, [ids], options)`

Resumes a set of cancelled jobs.

### `retry(name, id, options)`

Retries a failed job.

### `retry(name, [ids], options)`

Retries a set of failed jobs.

### `complete(name, id, data, options)`

Completes an active job. This would likely only be used with `fetch()`. Accepts an optional `data` argument for job output and an optional `options` object.

**options**

* **includeQueued**, bool

  Default: false. When false (default), only jobs in `active` state can be completed. When true, jobs in `created`, `retry`, or `active` states can be completed. This is useful for completing jobs that haven't been fetched yet, or for marking failed jobs as complete without retrying them.

  ```js
  // Complete a job without fetching it first
  await boss.complete('my-queue', jobId, { result: 'done' }, { includeQueued: true })
  ```

* **db**, object, see notes in `send()`

The promise will resolve on a successful completion, or reject if the job could not be completed.

### `complete(name, [ids], options)`

Completes a set of active jobs (or queued jobs when `includeQueued: true` is specified).

The promise will resolve on a successful completion, or reject if not all of the requested jobs could not be marked as completed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.

### `fail(name, id, data, options)`

Marks an active job as failed.

The promise will resolve on a successful assignment of failure, or reject if the job could not be marked as failed.

### `fail(name, [ids], options)`

Fails a set of active jobs.

The promise will resolve on a successful failure state assignment, or reject if not all of the requested jobs could not be marked as failed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.


### `getJobById(name, id, options)`

> **Deprecated:** Use `findJobs()` instead.

Retrieves a job with all metadata by name and id

**options**

* **db**, object, see notes in `send()`

### `findJobs(name, options)`

Finds jobs in a queue by id, singleton key, and/or data. Returns an array of jobs with all metadata.

**Arguments**
- `name`: string, *required*
- `options`: object

**options**

* **id**, string

  Find a job by its id

* **key**, string

  Find jobs by their singletonKey

* **data**, object

  Find jobs where the job data contains the specified key-value pairs (top-level matching only)

* **queued**, bool, *default: false*

  If `true`, only return jobs in queued state (created or retry). If `false`, return jobs in any state.

* **db**, object, see notes in `send()`

**Examples**

```js
// Find by id
const jobs = await boss.findJobs('my-queue', { id: 'abc-123' })

// Find by singletonKey
const jobs = await boss.findJobs('my-queue', { key: 'user-123' })

// Find by data
const jobs = await boss.findJobs('my-queue', { data: { type: 'email' } })

// Find queued jobs only
const jobs = await boss.findJobs('my-queue', { key: 'user-123', queued: true })

// Combine filters
const jobs = await boss.findJobs('my-queue', {
  key: 'user-123',
  data: { type: 'email' },
  queued: true
})
```