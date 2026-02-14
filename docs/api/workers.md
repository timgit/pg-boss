# Workers

### `work()`

Adds a new polling worker for a queue and executes the provided callback function when jobs are found. Each call to work() will add a new worker and resolve a unqiue worker id.

Workers can be stopped via `offWork()` all at once by queue name or individually by using the worker id. Worker activity may be monitored by listening to the `wip` event.

The default options for `work()` is 1 job every 2 seconds.

### `work(name, options, handler)`

**Arguments**
- `name`: string, *required*
- `options`: object
- `handler`: function(jobs), *required*

**Options**

* **batchSize**, int, *(default=1)*

  Same as in [`fetch()`](#fetch)

* **includeMetadata**, bool, *(default=false)*

  Same as in [`fetch()`](#fetch)

* **priority**, bool, *(default=true)*

  Same as in [`fetch()`](#fetch)

* **orderByCreatedOn**, bool, *(default=true)*

  Same as in [`fetch()`](#fetch)

* **pollingIntervalSeconds**, int, *(default=2)*

  Interval to check for new jobs in seconds, must be >=0.5 (500ms)

* **localConcurrency**, int, *(default=1)*

  Number of workers to spawn for this queue within the current Node.js process. Each worker polls and processes jobs independently, enabling parallel job processing within a single `work()` call.

  > **Note**: This is a per-node setting. In a distributed deployment with multiple nodes, each node manages its own workers independently. For example, if you have 3 nodes each calling `work()` with `localConcurrency: 5`, you'll have 15 total workers across your cluster.

  ```js
  // Create 5 workers that can each process jobs in parallel
  await boss.work('email-welcome', { localConcurrency: 5 }, async ([job]) => {
    await sendEmail(job.data)
  })
  ```

* **localGroupConcurrency**, int | object

  Limits how many jobs from the same group can be processed simultaneously **within the current Node.js process**. This is tracked in-memory with no database overhead.

  Can be specified as:
  - A simple number: `localGroupConcurrency: 2` - limits all groups to 2 concurrent jobs per node
  - An object with tier-based limits (see `groupConcurrency` below for format)

  > **Note**: This is a per-node limit. In a distributed deployment, each node enforces its own limit independently. Use `groupConcurrency` instead if you need global coordination across nodes.

  ```js
  // Limit each tenant to 2 concurrent jobs on this node (no DB overhead)
  await boss.work('process-data', {
    localConcurrency: 10,
    localGroupConcurrency: 2
  }, async ([job]) => {
    await processData(job.data)
  })
  ```

* **heartbeatRefreshSeconds**, number

  Custom interval in seconds at which the worker sends heartbeats for active jobs. Defaults to `heartbeatSeconds / 2` (derived from the job's heartbeat configuration). Must be strictly less than `heartbeatSeconds`.

  This option only applies when jobs have `heartbeatSeconds` configured (either on the queue or per-job). Heartbeats are sent automatically by `work()` — no user action is needed unless a custom refresh interval is desired.

  ```js
  // Queue configured with 60s heartbeat, worker sends heartbeats every 10s
  await boss.work('video-processing', { heartbeatRefreshSeconds: 10 }, async ([job]) => {
    await processVideo(job.data)
  })
  ```

* **groupConcurrency**, int | object

  Limits how many jobs from the same group can be processed simultaneously **globally across all nodes**. This is enforced via database queries.

  Can be specified as:
  - A simple number: `groupConcurrency: 2` - limits all groups to 2 concurrent jobs globally
  - An object with tier-based limits:
    ```js
    groupConcurrency: {
      default: 1,           // Default limit for groups without a tier
      tiers: {
        enterprise: 5,      // Enterprise tier can have 5 concurrent jobs
        pro: 2              // Pro tier can have 2 concurrent jobs
      }
    }
    ```

  Jobs are assigned to groups using the `group` option in `send()`. Jobs without a group are not limited by groupConcurrency.

  > **Note**: The `groupConcurrency` limit is enforced globally across all nodes by tracking active jobs in the database. However, due to the optimistic locking nature of job fetching, there may be brief moments where the limit is slightly exceeded during race conditions when multiple workers fetch jobs simultaneously.

  ```js
  // Limit each tenant to 2 concurrent jobs globally across all nodes
  await boss.work('process-data', {
    localConcurrency: 10,
    groupConcurrency: 2
  }, async ([job]) => {
    await processData(job.data)
  })
  ```

#### Understanding concurrency options

The three concurrency options work together to control job processing at different levels:

| Option | Scope | Tracking | Use case |
| - | - | - | - |
| `localConcurrency` | Per-node | N/A (worker count) | Control total parallel processing capacity per node |
| `localGroupConcurrency` | Per-node, per-group | In-memory | Limit group concurrency without DB overhead |
| `groupConcurrency` | Global, per-group | Database | Coordinate group limits across distributed nodes |

**Key relationships:**

- `localConcurrency` sets the maximum number of jobs a single node can process simultaneously (limited by worker count)
- `localGroupConcurrency` must be ≤ `localConcurrency` (you can't process more jobs from a group than you have workers)
- `groupConcurrency` can exceed `localConcurrency` because it's a global limit across all nodes

**Example: Multi-node deployment**

```js
// 3 nodes, each running:
await boss.work('process-tenant-data', {
  localConcurrency: 5,      // Each node has 5 workers (15 total across cluster)
  groupConcurrency: 10      // Max 10 jobs from same tenant globally
}, handler)
```

In this setup:
- Each node can process up to 5 jobs simultaneously (limited by `localConcurrency`)
- Across all 3 nodes, at most 10 jobs from the same group/tenant can be active (enforced by `groupConcurrency` via DB)
- This ensures predictable load on external resources (APIs, databases) per tenant

**Choosing between `localGroupConcurrency` and `groupConcurrency`:**

- Use `localGroupConcurrency` when you only need per-node fairness and want zero database overhead
- Use `groupConcurrency` when you need strict global limits across a distributed deployment
- You cannot use both simultaneously - choose one based on your requirements

**Handler function**

`handler` should return a promise (Usually this is an `async` function). If an unhandled error occurs in a handler, `fail()` will automatically be called for the jobs, storing the error in the `output` property, making the job or jobs available for retry.

The jobs argument is an array of jobs with the following properties.

| Prop | Type | |
| - | - | -|
|`id`| string, uuid |
|`name`| string |
|`data`| object |
|`heartbeatSeconds`| number \| null | Heartbeat interval configured for this job, or null if not configured |
|`signal`| AbortSignal |


An example of a worker that checks for a job every 10 seconds.

```js
await boss.work('email-welcome', { pollingIntervalSeconds: 10 }, ([ job ]) => myEmailService.sendWelcomeEmail(job.data))
```

An example of a worker that returns a maximum of 5 jobs in a batch.

```js
await boss.work('email-welcome', { batchSize: 5 }, (jobs) => myEmailService.sendWelcomeEmails(jobs.map(job => job.data)))
```

### `work(name, handler)`

Simplified work() without an options argument

```js
await boss.work('email-welcome', ([ job ]) => emailer.sendWelcomeEmail(job.data))
```

work() with active job deletion

```js
const queue = 'email-welcome'

await boss.work(queue, async ([ job ]) => {
  await emailer.sendWelcomeEmail(job.data)
  await boss.deleteJob(queue, job.id)
})
```

work() with abort signal

```js
await boss.work('process-video', async ([ job ]) => {
  const result = await fetch('https://api.example.com/process', { signal: job.signal })
})
```

### `notifyWorker(id)`

Notifies a worker by id to bypass the job polling interval (see `pollingIntervalSeconds`) for this iteration in the loop.


### `offWork(name, options)`

Removes a worker by name or id and stops polling.

** Arguments **
- name: string
- options: object

**Options**

* **wait**, boolean, *(default=true)*

  If the promise should wait until current jobs finish

* **id**, string

  Only stop polling by worker id
