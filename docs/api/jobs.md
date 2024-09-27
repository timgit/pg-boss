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

Available in constructor as a default, or overridden in send.

* **retryLimit**, int

    Default: 0. Max number of retries of failed jobs. Default is no retries.

* **retryDelay**, int

    Default: 0. Delay between retries of failed jobs, in seconds.

* **retryBackoff**, bool

    Default: false. Enables exponential backoff retries based on retryDelay instead of a fixed delay. Sets initial retryDelay to 1 if not set.

**Expiration options**

* **expireInSeconds**, number

    How many seconds a job may be in active state before it is failed because of expiration. Must be >=1

* **expireInMinutes**, number

    How many minutes a job may be in active state before it is failed because of expiration. Must be >=1

* **expireInHours**, number

    How many hours a job may be in active state before it is failed because of expiration. Must be >=1

* Default: 15 minutes

  > When a higher unit is is specified, lower unit configuration settings are ignored.

**Retention options**

* **retentionSeconds**, number

    How many seconds a job may be in created or retry state before it's archived. Must be >=1

* **retentionMinutes**, number

    How many minutes a job may be in created or retry state before it's archived. Must be >=1

* **retentionHours**, number

    How many hours a job may be in created or retry state before it's archived. Must be >=1

* **retentionDays**, number

    How many days a job may be in created or retry state before it's archived. Must be >=1

* Default: 30 days

  > When a higher unit is is specified, lower unit configuration settings are ignored.

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

**Throttle or debounce jobs**

* **singletonSeconds**, int
* **singletonMinutes**, int
* **singletonHours**, int
* **singletonNextSlot**, bool
* **singletonKey** string

Throttling jobs to 'one per time slot', where units could be seconds, minutes, or hours.  This option is set on the send side of the API since jobs may or may not be created based on the existence of other jobs.

For example, if you set the `singletonMinutes` to 1, then submit 2 jobs within the same minute, only the first job will be accepted and resolve a job id.  The second request will resolve a null instead of a job id.

> When a higher unit is is specified, lower unit configuration settings are ignored.

Setting `singletonNextSlot` to true will cause the job to be scheduled to run after the current time slot if and when a job is throttled. This option is set to true, for example, when calling the convenience function `sendDebounced()`.

As with queue policies, using `singletonKey` will extend throttling to allow one job per key within the time slot.

**Dead Letter Queues**

* **deadLetter**, string

When a job fails after all retries, if a `deadLetter` property exists, the job's payload will be copied into that queue,  copying the same retention and retry configuration as the original job.


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

### `send(request)`

**Arguments**

- `request`: object

The request object has the following properties.

| Prop | Type | |
| - | - | -|
|`name`| string | *required*
|`data`| object |
|`options` | object |


This overload is for conditionally including data or options based on keys in an object, such as the following.

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

### `insert(Job[])`

Create multiple jobs in one request with an array of objects.

The contract and supported features are slightly different than `send()`, which is why this function is named independently.  For example, debouncing is not supported.

The following contract is a typescript defintion of the expected object. Only `name` is required, but most other properties can be set. This will likely be enhanced later with more support for deferral and retention by an offset. For now, calculate any desired timestamps for these features before insertion.

```ts
interface JobInsert<T = object> {
  id?: string,
  name: string;
  data?: T;
  priority?: number;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  startAfter?: Date | string;
  singletonKey?: string;
  expireInSeconds?: number;
  keepUntil?: Date | string;
  deadLetter?: string;
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

  * `includeMetadata`, bool, *default: false*

    If `true`, all job metadata will be returned on the job object.

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
      expireIn: PostgresInterval;
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

### `cancel(name, id, options)`

Cancels a pending or active job.

### `cancel(name, [ids], options)`

Cancels a set of pending or active jobs.

When passing an array of ids, it's possible that the operation may partially succeed based on the state of individual jobs requested. Consider this a best-effort attempt. 

### `resume(name, id, options)`

Resumes a cancelled job.

### `resume(name, [ids], options)`

Resumes a set of cancelled jobs.

### `complete(name, id, data, options)`

Completes an active job. This would likely only be used with `fetch()`. Accepts an optional `data` argument.

The promise will resolve on a successful completion, or reject if the job could not be completed.

### `complete(name, [ids], options)`

Completes a set of active jobs.

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

Retrieves a job with all metadata by name and id

**options**

* `includeArchive`: bool, default: false

  If `true`, it will search for the job in the archive if not found in the primary job storage.

