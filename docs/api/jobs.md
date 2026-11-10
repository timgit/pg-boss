# Jobs

## Creating jobs

### `send()`

Creates a new job and returns the job id.

> [!NOTE]
> `send()` can resolve `null` instead of a job id when you use unique jobs, throttling, or a non-standard queue policy.

### `send(name, data, options)`

**Arguments**

- `name`: string, *required*
- `data`: object
- `options`: object


**General options**

* **priority**, int

  Optional priority. Higher numbers have higher priority.

* **id**, uuid

  Optional id. If you don't set an id, pg-boss creates a uuid.

* **deadLetter**, string

  Optional. The queue this job is copied to when it fails for the last time, in place of the queue's own dead letter queue.

**Retry options**

* **retryLimit**, int

  Default: 2. How many times pg-boss retries a failed job.

* **retryDelay**, int

  Default: 0. Delay between retries of failed jobs, in seconds.

* **retryBackoff**, bool

  Default: false. Retries with exponential backoff based on retryDelay, instead of a fixed delay. If retryDelay isn't set, it starts at 1. Roughly, the delay between runs is `retryDelay * 2 ^ retryCount` with some jitter. The full function for the backoff delay is `Math.min(retryDelayMax, retryDelay * (2 ** Math.min(16, retryCount + 1) / 2 + 2 ** Math.min(16, retryCount + 1) / 2 * Math.random()))`, where `retryCount` is the count before this retry (0 on the first failure).

* **retryDelayMax**, int

  Default: no limit. Maximum delay between retries of failed jobs, in seconds. Only used when retryBackoff is true.

**Heartbeat options**

* **heartbeatSeconds**, int

  Default: none (disabled). Expected heartbeat interval in seconds. Overrides the queue-level `heartbeatSeconds` for this job. When it's set, `work()` sends heartbeats for you. If no heartbeat arrives within this interval, the monitor fails or retries the job. Must be >= 10. See [Heartbeat vs expiration](queues#heartbeat-vs-expiration) for guidance on when to use a heartbeat and recommended values.

**Expiration options**

* **expireInSeconds**, number

  Default: 15 minutes. How many seconds a job can stay active before it's retried or failed. Must be >=1 and <= 86400 (24 hours).

**Retention options**

* **retentionSeconds**, number

  Default: 14 days. How many seconds a job can stay in created or retry state before it's deleted, counted from when it may start (`startAfter`). A retry, `retry()`, `resume()` and an `update()` that changes `startAfter` each start the count again from the job's new start time. Must be >=1.

* **deleteAfterSeconds**, int

  Default: 7 days. How long the database keeps a job after it's completed. Set to 0 to never delete completed jobs.


You can also set every retry, expiration and retention option on the queue. Each job inherits the queue's values unless it overrides them.
  
**Connection options**

* **db**, object

  You can use your own adapter in place of pg-boss's default adapter, as long as it implements this interface (the same as the pg module).

    ```ts
    interface Db {
      executeSql(text: string, values: any[]): Promise<{ rows: any[] }>;
  }
    ```

  pg-boss ships with built-in adapters for popular ORMs. See [ORM Transaction Adapters](./adapters) for details.

**Deferred jobs**

* **startAfter** int, string, or Date
  * int: seconds to delay starting the job
  * string: Start after an ISO 8601 date time string, or after a relative interval
  * Date: Start after a Date object

    Default: 0

  A string that begins with an ISO 8601 calendar date (`YYYY-MM-DD`) is read as a date time. If it
  has an explicit zone designator (`Z` or an offset such as `+05:30`), it resolves to that exact
  instant. If it has none, it's read as UTC whatever the
  database's time zone is.

  | String | Resolves to |
  | --- | --- |
  | `'2027-01-01T08:00:00Z'` | 2027-01-01 08:00 UTC |
  | `'2027-01-01T08:00:00.123Z'` | 2027-01-01 08:00:00.123 UTC |
  | `'2027-01-01T08:00:00+00:00'` | 2027-01-01 08:00 UTC |
  | `'2027-01-01T08:00:00+0000'` | 2027-01-01 08:00 UTC |
  | `'2027-01-01T08:00:00+00'` | 2027-01-01 08:00 UTC |
  | `'2027-01-01T13:30:00+05:30'` | 2027-01-01 08:00 UTC |
  | `'2027-01-01T00:00:00-08:00'` | 2027-01-01 08:00 UTC |
  | `'20270101T080000Z'` (basic format) | 2027-01-01 08:00 UTC |
  | `'2027-01-01T08:00:00'` | 2027-01-01 08:00 UTC |
  | `'2027-01-01T08:00'` | 2027-01-01 08:00 UTC |
  | `'2027-01-01 08:00:00'` | 2027-01-01 08:00 UTC |
  | `'2027-01-01'` | 2027-01-01 00:00 UTC |

  A string naming a time zone instead of an offset (`'2027-01-01 08:00:00 America/New_York'`) is
  left for the database to resolve and follows that zone's rules, including daylight saving.

  Any other string is read as a relative delay from now in Postgres interval syntax, such as
  `'5 minutes'`, `'1 hour'`, `'PT1H'` or `'90'` (bare seconds). A string that begins
  with a calendar date but isn't a valid date time (`'2027-13-45'`) is an error and isn't read as a delay.

  The ISO 8601 year-month and ordinal date formats are *not* recognized as date times.
  pg-boss reads them as long delays and doesn't reject them, because they're valid Postgres intervals:

  | String | Read as |
  | --- | --- |
  | `'2027-01'` | a delay of 2027 years 1 month |
  | `'2027-001'` | a delay of 2027 years 1 month |

  ```js
  await boss.send('email-reminder', { userId: 123 }, { startAfter: '2027-01-01T08:00:00Z' })
  await boss.send('email-reminder', { userId: 123 }, { startAfter: '2027-01-01T13:30:00+05:30' })
  await boss.send('email-reminder', { userId: 123 }, { startAfter: '1 hour' })
  ```

**Group options**

* **group**, object

  Puts a job in a group for `groupConcurrency` in `work()`, which limits how many jobs from the same group run at once.

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

These options throttle jobs to one per time slot. You set them when sending, because whether a job is created depends on the jobs that already exist.

For example, if you set `singletonSeconds` to 60 and send 2 jobs within the same minute, only the first is accepted and resolves a job id. The second resolves `null`.

When a job is throttled and `singletonNextSlot` is true, pg-boss schedules the job to run after the current time slot. For example, `sendDebounced()` sets this option to true.

As with queue policies, the throttle allows one job per `singletonKey` within the time slot.

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

This overload takes a single object with name, data, and options properties.

```js
const jobId = await boss.send({
    name: 'database-backup',
    options: { retryLimit: 1 }
})

console.log(`job ${jobId} submitted`)
```

### `sendAfter(name, data, options, value)`

Sends a job that starts after a number of seconds from now, or after a specific date time.

It's a shorthand for `send()` with the `startAfter` option set.

`value` is an int (seconds), a string (an ISO 8601 date time or a relative interval), or a Date.

See [`startAfter`](#send-name-data-options) for how a string is interpreted.

```js
// start in 5 minutes
await boss.sendAfter('email-reminder', { userId: 123 }, null, 300)

// start at a specific date and time
await boss.sendAfter('email-reminder', { userId: 123 }, null, new Date('2027-01-01T08:00:00Z'))

// same instant, expressed with an offset instead of Z
await boss.sendAfter('email-reminder', { userId: 123 }, null, '2027-01-01T13:30:00+05:30')
```

### `sendThrottled(name, data, options, seconds, key)`

Sends at most one job to the same queue within a number of seconds. The first job in the interval is accepted. For every other job in the same interval, the call creates nothing and resolves `null`.

It's a shorthand for `send()` with the `singletonSeconds` and `singletonKey` options set. The `key` argument is optional.

```js
// accept at most 1 job per user per minute; extra sends resolve null
const jobId = await boss.sendThrottled('sync-profile', { userId: 123 }, null, 60, `user-${123}`)

if (!jobId) {
  console.log('job was throttled')
}
```

### `sendDebounced(name, data, options, seconds, key)`

Works like `sendThrottled()`, except that when a job was already sent in the current interval, it adds the job to the next interval if the next interval has no job yet.

It's a shorthand for `send()` with the `singletonSeconds`, `singletonKey` and `singletonNextSlot` options set. The `key` argument is optional.

```js
// coalesce bursts of edits: at most 1 job per document per 30 seconds,
// and if the slot is taken, schedule one for the next slot
await boss.sendDebounced('reindex-document', { docId: 'doc-1' }, null, 30, 'doc-1')
```

### `update(name, data, options)`

Updates the payload and options of one or more **not-yet-active** jobs (state `created` or `retry`). Jobs in any other state, `active` included, can't be updated. If nothing matches, it resolves with an empty `jobs` array and `updated: 0`.

Target the job with **exactly one** of:

- `options.id`: a single job by id.
- `options.singletonKey`: jobs sharing that key.

Only the fields you supply change; any option you omit keeps the job's current value. Passing only a new `data` payload with a target replaces the payload and leaves the job's existing `startAfter`, `priority`, retry settings and so on as they were.

You can update these fields:

* `data`
* `priority`
* `startAfter`
* `retryLimit`
* `retryDelay`
* `retryBackoff`
* `retryDelayMax`
* `expireInSeconds`
* `retentionSeconds`
* `deleteAfterSeconds`
* `deadLetter`
* `heartbeatSeconds`
* `group`

The job always keeps its `singletonKey` and `singletonOn` (throttle slot). To change only options and keep the payload, pass `undefined` for `data`. Passing `null` clears the payload.

If the updated job can now run (its `startAfter` is in the past) and its queue has `LISTEN`/`NOTIFY` enabled, pg-boss sends a wake-up notification so idle workers fetch it promptly.

Returns a `Promise<UpdateResponse>`: `{ jobs, updated }`, where `jobs` are the affected ids and `updated` is the number of jobs updated (equal to `jobs.length`).

```js
// by id
await boss.update('email', { to: 'a@b.co', retries: 0 }, { id: jobId })

// by singletonKey
await boss.update('article', { articleId: 42, body: '…latest…' }, { singletonKey: 'article-42' })
```

A `singletonKey` is only guaranteed unique per state under the `short` and `stately` policies. Under throttling or debouncing, or with a key you set yourself on a `standard` queue, several pre-active jobs can share a key. `options.match` uses their `createdOn` order to pick which of those jobs to update:

- `newest` (default): overwrite the most recently created match.
- `oldest`: overwrite the earliest created match.
- `all`: overwrite every match.

`match` is only valid when targeting by `singletonKey`.

### `update({ name, data, options })`

This overload takes a single object with name, data, and options properties. `data` is optional. Omit it to change only options.

```js
await boss.update({
  name: 'article',
  data: { articleId: 42, body: '…latest…' },
  options: { singletonKey: 'article-42' }
})
```

### `upsert(name, data, options)`

Updates one or more **not-yet-active** jobs (state `created` or `retry`), or inserts a job when none match. It's meant for special cases. `send()` stays the usual way to create jobs. `upsert()` runs `update()` first and runs `insert()` if nothing matches. It takes the same options as `update()`. When matching by `id`, pg-boss creates the new job with that id. With `singletonKey`, it supports the same `match` option as `update()`. On a `key_strict_fifo` queue, an insert requires `singletonKey`.

Returns a `Promise<UpsertResponse>`: `{ jobs, updated, inserted }`. On a hit, `updated` reflects the updated job(s) and `inserted` is `0`; on a miss, `inserted` is `1` and `jobs` holds the new id.

Concurrent `upsert()` calls with the same `singletonKey` agree on one job. At most one of them inserts. The others update that job and wait for the inserting call's transaction to finish when they have to. Between upserts, the guarantee holds on every queue policy and inside a transaction passed as `db`. A `send()` or `insert()` with the same key still adds a job of its own wherever the queue policy accepts several queued jobs per key (`standard`, `singleton` and `key_strict_fifo`). A job brought back with `resume()` also queues beside a newer upserted job and doesn't replace it.

On CockroachDB the later upsert fails with a serialization error (`40001`) instead of waiting. When pg-boss owns the transaction, it runs the upsert for up to 3 attempts in all. Inside a `db` you pass, the call rejects with the error for you to retry.

```js
// ensure exactly one queued "process this article" job carries the latest body
await boss.upsert('article', { articleId: 42, body: '…latest…' }, { singletonKey: 'article-42' })
```


### `upsert({ name, data, options })`

This overload takes a single object with name, data, and options properties, like `update({ name, data, options })`.

```js
await boss.upsert({
  name: 'article',
  data: { articleId: 42, body: '…latest…' },
  options: { singletonKey: 'article-42' }
})
```

### `insert(name, Job[], options)`

Creates several jobs in one request from an array of objects.

Its contract and features differ slightly from `send()`, which is why it has its own name. For example, it doesn't support debouncing, and it doesn't return job IDs unless spies are enabled or `options.returnId` is `true`.

Each job is an object of this shape:

```ts
interface JobInsert<T = object> {
  id?: string;
  data?: T;
  priority?: number;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
  startAfter?: number | string | Date;
  singletonKey?: string;
  singletonSeconds?: number;
  expireInSeconds?: number;
  deleteAfterSeconds?: number;
  retentionSeconds?: number;
  heartbeatSeconds?: number;
  group?: { id: string; tier?: string };
  deadLetter?: string;
}
```

Each field works like the `send()` option of the same name. For example, a `startAfter` string is interpreted exactly as it is in [`send()`](#send-name-data-options).

Returns a `Promise<string[] | null>`. Without `returnId: true` and with spies off, it resolves to `null`. With `returnId: true`, it resolves to the ids of the jobs that were inserted, or to `null` when no jobs were inserted (an empty input array included). It doesn't resolve to an empty array. The example below adds `?? []` to always get an array back.

Behind the scenes, `insert()` is a single `INSERT` statement. An error on any job (a value of the wrong type, for example) rolls back the whole batch. pg-boss skips a job that conflicts with an existing job and still inserts the rest of the batch. Conflicts are a duplicate `id`, a second job in the same `singletonSeconds` throttle slot, or a second queued job for the same `singletonKey` on a queue whose [policy](./queues#createqueue-name-queue) accepts only one queued job per key (`short`, `stately` or `exclusive`). The returned ids can then be fewer than the jobs passed in. They also aren't guaranteed to line up with the input by position. To match input jobs to output ids, set each job's `id` in the input array. Use [`flow()`](#flow-jobs-options) when the batch must be all or nothing, since it rolls back if any job is skipped. With a custom `db`, the insert commits or rolls back with your transaction.

```js
const ids = await boss.insert('etl', [
  { data: { step: 'extract' } },
  { data: { step: 'transform' } }
], { returnId: true }) ?? []
```

## Flows

### `flow(jobs, options)`

Creates a set of jobs and their dependencies atomically in one transaction.

Use `flow()` when jobs depend on other jobs. `send()` and `insert()` don't take dependencies, because creating jobs and dependencies in separate calls can race with job completion.

pg-boss makes the call atomic when it owns the database connection. If you pass a custom `db` in `options`, wrap the call in your own transaction if the job and dependency inserts must commit or roll back together.

The method accepts a flat array of jobs in any order. Each job has a local `ref`. Dependent jobs reference parent refs with `dependsOn`.

```ts
interface FlowJob {
  ref: string;
  name: string;
  data?: object;
  options?: Omit<JobInsert, 'data'>;
  dependsOn?: string[];
}
```

Returns a map of `ref` to created job id.

```js
const flow = await boss.flow([
  { ref: 'extract-a', name: 'extract', data: { file: '1.csv' } },
  { ref: 'extract-b', name: 'extract', data: { file: '2.csv' } },
  {
    ref: 'load',
    name: 'load',
    data: { output: 'report.csv' },
    dependsOn: ['extract-a', 'extract-b']
  }
])

const loadJobId = flow.load
```

Dependent jobs are created in a `blocked` state. `fetch()` skips them until all their parent jobs have completed. If a parent job fails or is cancelled, the child stays blocked. You can `cancel` or `fail` the blocked child yourself.

A dependent job with `startAfter` can be fetched only once all its dependencies have completed and `startAfter` has passed. When its last dependency resolves, its `startAfter` moves up to that moment unless it's already later. `startAfter` then reads as the time the job could first run. The job's wait in [`getQueueStats()`](./queues.md#getqueuestats-name-options) counts from that time.

Unblocking happens off the completion hot path. A background resolver wakes shortly after a parent completes (see [`flowIntervalSeconds`](./constructor.md#flowintervalseconds) in the constructor options) and unblocks any dependents that are now ready. So completing a job stays fast however many flows exist. The resolver runs when `supervise` is enabled. Call [`resolveFlow()`](#resolveflow) to force a pass immediately (e.g. in tests).

### `resolveFlow()`

Runs a flow-resolution pass without waiting for the next background cycle and unblocks the dependents of any parents that have completed. Returns a promise that resolves when the pass finishes. Use it for deterministic tests, or when you've disabled `supervise` and drive maintenance yourself.

A call made while another pass is in flight waits for that pass to finish. `stop()` waits for a running call. A call after `stop()` resolves without running.

```js
await boss.complete('extract', parentJobId)

// unblock any ready dependents now instead of waiting for the next cycle
await boss.resolveFlow()
```

## Fetching jobs

### `fetch(name, options)`

Returns an array of jobs from a queue.

**Arguments**
- `name`: string
- `options`: object

  * `batchSize`, int, *default: 1*

    Number of jobs to return.

  * `priority`, bool, **deprecated, ignored since 12.30.0**

    Jobs are always fetched in priority order. This option existed to skip the priority sort for throughput. There is no sort to skip, because the fetch index is ordered to match the fetch. Setting it `false` was measured roughly 180x *slower* than leaving it alone, because no index leads with `created_on`. Setting it to `false` emits a Node `DeprecationWarning` (code `PGBOSS_DEP_FETCH_SORT`) once per option per instance, and the next major will reject it. Run with `--trace-deprecation` to find the call site.

  * `orderByCreatedOn`, bool, **deprecated, ignored since 12.30.0**

    Jobs are always fetched in creation order. Disabling the option saved nothing measurable, because the fetch index provides that order directly.

  * `includeMetadata`, bool, *default: false*

    If `true`, the job object includes all job metadata.

  * `ignoreStartAfter`, bool, *default: false*

    If `true`, fetch also returns jobs with a `startAfter` timestamp in the future. Use it to fetch jobs immediately without waiting out a retry delay.

  * `minPriority`, int

    If set, fetch returns only jobs with a priority greater than or equal to this value. When used with `maxPriority`, `minPriority` must be less than or equal to `maxPriority`.

  * `maxPriority`, int

    If set, fetch returns only jobs with a priority less than or equal to this value. When used with `minPriority`, `minPriority` must be less than or equal to `maxPriority`.

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
      retryDelayMax?: number;
      startAfter: Date;
      startedOn: Date;
      singletonKey: string | null;
      singletonOn: Date | null;
      groupId: string | null;
      groupTier: string | null;
      expireInSeconds: number;
      heartbeatSeconds: number | null;
      heartbeatOn: Date | null;
      deleteAfterSeconds: number;
      createdOn: Date;
      completedOn: Date | null;
      keepUntil: Date;
      blocked: boolean,
      blocking: boolean,
      pendingDependencies: number,
      deadLetter: string,
      policy: string,
      output: object,
      sourceName: string | null,
      sourceId: string | null,
      sourceCreatedOn: Date | null,
      sourceRetryCount: number | null,
      sourceOutput: object | null,
      sourceRootId: string | null
    }
    ```

When a job moves into a dead letter queue, the `source*` fields record where it
came from:

- `sourceName` is the queue it originally failed on.
- `sourceId` is the id of the original job.
- `sourceCreatedOn` is the original job's creation time.
- `sourceRetryCount` is how many retries it used before it was dead-lettered.
- `sourceOutput` is the original job's `output` when it failed, which is usually its error.

The dead-lettered job's own `output` starts empty, since it's a new job that hasn't run.
`sourceId` only names the previous hop, which after a redrive is the redriven copy.
On the first failure, `sourceRootId` is the same as `sourceId`.
These fields are `null` for jobs that weren't dead-lettered.

You can find a job's whole history from its original id, because after a redrive every later
dead-lettered and redriven copy of the job carries the same `sourceRootId`.

**Notes**

This example fetches and deletes up to 20 jobs.

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

## Deleting and redriving jobs

### `deleteJob(name, id, options)`

Deletes a job by id. Accepts a fetched job in place of its id, which only deletes the attempt that was fetched (see [passing jobs instead of ids](#passing-jobs-instead-of-ids)).

> [!NOTE]
> `deleteJob()` supports a "fetch then delete" workflow like SQS's. Everything works out of the box because workers don't delete jobs by default. Throttling and debouncing in particular need jobs to exist to enforce a unique constraint. For example, if you debounce a queue to "only allow 1 job per hour", deleting jobs after processing reopens that time slot and breaks your throttling policy.

```js
const [job] = await boss.fetch('email-send')
await emailer.send(job.data)
await boss.deleteJob('email-send', job)
```

### `deleteJob(name, [ids], options)`

Deletes a set of jobs by id.

```js
const jobs = await boss.fetch('email-send', { batchSize: 20 })
await boss.deleteJob('email-send', jobs.map(job => job.id))
```

### `redrive(name, options)`

Moves jobs out of a dead letter queue and re-creates them as fresh jobs on their original source queue. `name` is the
dead letter queue to drain. Returns the number of jobs moved.

Each job goes back to the queue it originally failed on (its `sourceName`).
A single dead letter queue that collects from many source queues fans back out
correctly. A re-created job gets a new id (with [`sourceRootId`](#fetch-name-options) still
pointing at the job `send()` returned), a reset retry count and cleared output.
It also gets the destination queue's current retry, retention, policy, expiration, heartbeat, and
deadLetter configuration. Per-job overrides passed to the original `send()` (such as
`expireInSeconds` or `retryLimit`) aren't restored, since the queue's configuration wins.
The job keeps its `priority`, `singletonKey`, and `group`. Its ordering weight
and group concurrency limits stay in effect. Only
jobs that aren't being processed (still in the `created`/`retry` state)
are moved.

`redrive()` can't recover jobs that were part of a flow. The dependents of a dead-lettered
parent stay blocked, because the parent never reaches the `completed` state. The
re-created job also has a new id that the existing dependency rows don't point at. Redriving
such a job runs it again on its own without resuming the original flow.

`options`:

- `destination`: a queue to move all matched jobs into, in place of each
  job's original source queue. Required to redrive jobs that have no recorded
  source queue (e.g. jobs dead-lettered before this feature existed). Without it, those
  jobs stay where they are.
- `sourceName`: only redrive jobs that originated from this source queue.
- `data`: only redrive jobs whose payload contains this object, matched the same
  way as [`findJobs()`](#findjobs-name-options).
- `createdBefore`: only redrive jobs that arrived in the dead letter queue before
  this `Date`. Pass the same value to every call of a loop to drain a fixed set
  that leaves out jobs dead-lettered while the loop runs.
- `ids`: only redrive these jobs, by their id in the dead letter queue.
- `limit`: maximum number of jobs to move in this call, oldest first (default
  `1000`). Loop or schedule repeated calls to drain large dead letter queues at a
  controlled rate.

The destination can refuse a re-created copy because its `short`, `stately` or
`exclusive` policy already holds a job with the same `singletonKey` (or an earlier job in the
same batch does). The job isn't lost. It stays in the dead letter queue in the `failed` state.
Its `output` records why (`reason: 'redrive_conflict'`, plus the `destination`, `policy`,
`singletonKey` and a `message`). Once the job it collided with has finished, retry the refused
job to make it a redrive candidate again. Otherwise the dead letter queue's `deleteAfterSeconds`
removes it like any other failed job.

In a dead letter queue with the `key_strict_fifo` policy, only the oldest collision per
`singletonKey` is failed. Jobs with a key that an active, retrying or failed job holds
aren't redrive candidates until that job is resolved, which is the same rule fetch follows.

`redrive()` doesn't move jobs that a dead letter queue's own workers have already failed.
Only jobs still waiting there are candidates. The return value counts only the jobs
re-created. If every waiting job collided, a call returns `0` even though jobs remained.
The next call moves on, because the collided jobs are now failed.

```js
// drain a dead letter queue back to its source queues, 500 at a time, stopping at the
// jobs that were already there when it started
const createdBefore = new Date()
let left
do {
  await boss.redrive('email-dlq', { limit: 500, createdBefore })
  left = await boss.previewRedrive('email-dlq', { createdBefore })
} while (left.total > left.unroutable)
```

### `previewRedrive(name, options)`

Reports what [`redrive()`](#redrive-name-options) would do with the same options,
without moving anything. It takes every `redrive()` filter and uses the same matching.
Its numbers agree with what a redrive would move at that moment.

It reads at most `limit` matching jobs of each kind and doesn't count past the limit:

- `limit`: most jobs to read of each kind (jobs a redrive would move, and jobs it
  would leave in place), from 1 to 100,000 (default `1000`). A count that reaches the
  limit means at least that many.

Returns `{ total, destinations, unroutable }`. Each field counts the jobs read:

- `total`: the matching jobs read, which includes the unroutable jobs.
- `destinations`: `{ name, count }` for each queue the matching jobs would land in,
  largest first. Without `destination`, the list is the fan-out back to each source queue.
- `unroutable`: matching jobs a redrive would leave in place, because they have no
  recorded source queue and no `destination` was given, or their source queue no
  longer exists.

A destination with a `short`, `stately` or `exclusive` policy can still refuse a job that
collides at redrive time, which leaves it failed in the dead letter queue with
`reason: 'redrive_conflict'`. The preview can't see those collisions ahead of time.

```js
const { total, destinations, unroutable } = await boss.previewRedrive('email-dlq', {
  data: { tenant: 'acme' },
  createdBefore: new Date(Date.now() - 24 * 60 * 60 * 1000)
})
```

### `deleteQueuedJobs(name)`

Deletes all queued jobs in a queue, and resolves to how many it deleted.

The delete isn't atomic, because it runs in batches with one transaction per batch. If it fails
partway, the batches before the failure stay deleted. A job sent while it runs may or may not
be deleted.

```js
await boss.deleteQueuedJobs('email-send')
```

### `deleteStoredJobs(name)`

Deletes all jobs in a queue in the completed, failed, and cancelled states, and resolves to how many
it deleted. Deletes in batches, as `deleteQueuedJobs()` does.

```js
await boss.deleteStoredJobs('email-send')
```

### `deleteAllJobs(name?)`

Deletes all jobs in a queue, including active jobs.

If you don't give a queue name, it deletes jobs from all queues.

It deletes in batches as `deleteQueuedJobs()` does and resolves to how many jobs it deleted. For a partitioned queue, and for every queue when no name is given, the call uses a single `TRUNCATE` instead. The call then resolves to `null`, because `TRUNCATE` reports no count. The cached counts in [`getQueue()`](./queues.md#getqueue-name) are zeroed at the same time. After any other delete (`deleteQueuedJobs()` and `deleteStoredJobs()` included), `totalCount` drops by the number of jobs deleted right away. The other cached counts catch up at the next monitor pass.

```js
// delete everything in one queue
await boss.deleteAllJobs('email-send')

// delete everything in all queues
await boss.deleteAllJobs()
```

## Cancelling, resuming, and retrying jobs

### `cancel(name, id, options)`

Cancels a pending or active job. Accepts a fetched job in place of its id, which only cancels the attempt that was fetched (see [passing jobs instead of ids](#passing-jobs-instead-of-ids)).

```js
await boss.cancel('email-send', jobId)
```

### `cancel(name, [ids], options)`

Cancels a set of pending or active jobs.

With an array of ids, the call can partly succeed, because whether each job is cancelled depends on its state. It's a best-effort operation.

```js
await boss.cancel('email-send', [jobId1, jobId2])
```

### `resume(name, id, options)`

Resumes a cancelled job. Its `startAfter` moves up to the time of the resume unless the current value is already later. The job's wait in [`getQueueStats()`](./queues.md#getqueuestats-name-options) counts from that `startAfter`.

```js
await boss.resume('email-send', jobId)
```

### `resume(name, [ids], options)`

Resumes a set of cancelled jobs.

```js
await boss.resume('email-send', [jobId1, jobId2])
```

### `retry(name, id, options)`

Retries a failed job. Its `startAfter` moves up to the time of the retry unless the current value is already later. The job's wait in [`getQueueStats()`](./queues.md#getqueuestats-name-options) counts from that `startAfter`.

```js
await boss.retry('email-send', jobId)
```

### `retry(name, [ids], options)`

Retries a set of failed jobs.

```js
// requeue failed jobs for another attempt
const failed = await boss.findJobs('email-send')
const ids = failed.filter(job => job.state === 'failed').map(job => job.id)

await boss.retry('email-send', ids)
```

## Completing and failing jobs

### Passing jobs instead of ids

`complete()`, `fail()`, `touch()`, `cancel()` and `deleteJob()` accept the jobs `fetch()` returned in place of their ids, or any object with the job's `id` and `retryCount`. The call then applies only to the attempt that was fetched. If the claim lapsed in the meantime (the job expired or missed its heartbeat, and another worker retried it), pg-boss leaves the job alone and reports it as not affected. The newer attempt doesn't get the older attempt's outcome.

```js
const [job] = await boss.fetch('report-generation')

const report = await generateReport(job.data)

// { affected: 0 } if the job was retried elsewhere while this report was generated
const { affected } = await boss.complete('report-generation', job, { reportUrl: report.url })
```

A plain id applies to whatever attempt currently holds the job, which is what an operator acting on a job wants. `work()` always settles and refreshes by attempt.

### `complete(name, id, data, options)`

Completes an active job. You'd usually call it only after `fetch()`. Accepts an optional `data` argument for job output and an optional `options` object.

```js
const [job] = await boss.fetch('report-generation')

const report = await generateReport(job.data)

await boss.complete('report-generation', job, { reportUrl: report.url })
```

**options**

* **includeQueued**, bool

  Default: false. When false, only jobs in the `active` state can be completed. When true, jobs in the `created`, `retry`, or `active` states can be completed. Use it to complete jobs that haven't been fetched yet, or to complete a job waiting in `retry` without running it again.

  ```js
  // Complete a job without fetching it first
  await boss.complete('my-queue', jobId, { result: 'done' }, { includeQueued: true })
  ```

* **db**, object, see notes in `send()`

The promise resolves with `{ jobs, requested, affected }`. `affected` is `1` when the job was completed and `0` when it couldn't be (for example, because it isn't active).

### `complete(name, [ids], data, options)`

Completes a set of active jobs (or queued jobs with `includeQueued: true`).

The promise resolves with `{ jobs, requested, affected }`, where `jobs` holds the ids passed, `requested` their count, and `affected` how many were completed. `affected` can be lower than `requested`, because pg-boss leaves alone any job it can't complete.

> [!NOTE]
> See the note on `cancel([ids])` about batch calls, which can partly succeed.

### `fail(name, id, data, options)`

Marks an active job as failed.

The promise resolves with `{ jobs, requested, affected }`. `affected` is `1` when the job was marked as failed and `0` when it couldn't be (for example, because it already completed).

`data` is stored as the job's output and accepts a value of any type, such as the error a `catch` block receives. An `Error` is stored with its name, message and stack. A plain object is stored as it is. An array, a string or a number is stored as `{ value }`. `null`, `undefined` or a function leaves the output empty.

```js
const [job] = await boss.fetch('email-send')

try {
  await emailer.send(job.data)
  await boss.complete('email-send', job)
} catch (err) {
  // stored in the job's output and eligible for retry per the queue config
  await boss.fail('email-send', job, err)
}
```

### `fail(name, [ids], data, options)`

Fails a set of active jobs.

```js
const jobs = await boss.fetch('email-send', { batchSize: 10 })

await boss.fail('email-send', jobs, { message: 'smtp outage' })
```

The promise resolves with `{ jobs, requested, affected }`, where `jobs` holds the ids passed, `requested` their count, and `affected` how many were marked as failed. `affected` can be lower than `requested`, because pg-boss leaves alone any job it can't fail.

> [!NOTE]
> See the note on `cancel([ids])` about batch calls, which can partly succeed.


### `touch(name, id, options)`

Updates the heartbeat timestamp for an active job, to show that its worker is still alive.

Call it when you process jobs yourself with `fetch()`. Workers started with `work()` send heartbeats for you when `heartbeatSeconds` is set.

```js
const [job] = await boss.fetch('long-running-queue')

const interval = setInterval(async () => {
  await boss.touch('long-running-queue', job)
}, 5000)

try {
  await processJob(job)
  await boss.complete('long-running-queue', job)
} finally {
  clearInterval(interval)
}
```

### `touch(name, [ids], options)`

Updates the heartbeat timestamp for a set of active jobs.

```js
const jobs = await boss.fetch('long-running-queue', { batchSize: 10 })

const result = await boss.touch('long-running-queue', jobs)
```

## Finding jobs

### `getJobById(name, id, options)`

> [!WARNING]
> **Deprecated:** Use `findJobs()` instead.

Retrieves a job with all metadata by name and id.

**options**

* **db**, object, see notes in `send()`

### `findJobs(name, options)`

Finds jobs in a queue by id, singleton key, data, or any combination of these. Returns an array of jobs with all metadata, oldest first.

**Arguments**
- `name`: string, *required*
- `options`: object

**options**

* **id**, string

  Finds a job by its id.

* **key**, string

  Finds jobs by their singletonKey.

* **data**, object

  Finds jobs whose data contains these key-value pairs (top-level matching only).

* **queued**, bool, *default: false*

  If `true`, returns only queued jobs (created or retry). If `false`, returns jobs in any state.

* **limit**, int, *default: 1000*

  Most jobs to return, from 1 to 100,000.

* **after**, string

  The id of the last job of the previous page, to read the next page. Rejects if that job no
  longer exists.

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

// At most 100 jobs from a large queue
const jobs = await boss.findJobs('my-queue', { data: { type: 'email' }, limit: 100 })

// Every job, 500 at a time
let after
for (;;) {
  const page = await boss.findJobs('my-queue', { limit: 500, after })
  if (page.length === 0) break
  after = page.at(-1).id
}

// Combine filters
const jobs = await boss.findJobs('my-queue', {
  key: 'user-123',
  data: { type: 'email' },
  queued: true
})
```

## Inspecting dependencies

### `getDependencies(name, id, options)`

Returns an array of references to the parent jobs the given job depends on, sorted by queue name and id. `options.limit` sets the most it returns (1 to 100,000, default 1000). Pass the last reference as `options.after` to read the next page.

```js
const parents = await boss.getDependencies('aggregate-results', jobId)
// [{ name: 'process-data', id: '...' }, { name: 'process-data', id: '...' }]
```

### `getDependents(name, id, options)`

Returns an array of references to the child jobs that depend on the given job, sorted by queue name and id. `options.limit` sets the most it returns (1 to 100,000, default 1000). Pass the last reference as `options.after` to read the next page.

```js
const children = await boss.getDependents('process-data', parentJobId)
// [{ name: 'aggregate-results', id: '...' }]
```