# pg-boss Docs<!-- omit in toc -->

<!-- TOC -->

- [Intro](#intro)
  - [Job states](#job-states)
- [Database install](#database-install)
- [Database uninstall](#database-uninstall)
- [Direct database interactions](#direct-database-interactions)
  - [Job table](#job-table)
- [Events](#events)
  - [`error`](#error)
  - [`wip`](#wip)
  - [`stopped`](#stopped)
- [Static functions](#static-functions)
  - [`string getConstructionPlans(schema)`](#string-getconstructionplansschema)
  - [`string getMigrationPlans(schema, version)`](#string-getmigrationplansschema-version)
  - [`string getRollbackPlans(schema, version)`](#string-getrollbackplansschema-version)
- [Functions](#functions)
  - [`new(connectionString)`](#newconnectionstring)
  - [`new(options)`](#newoptions)
  - [`start()`](#start)
  - [`stop(options)`](#stopoptions)
  - [`send()`](#send)
    - [`send(name, data, options)`](#sendname-data-options)
    - [`send(request)`](#sendrequest)
    - [`sendAfter(name, data, options, value)`](#sendaftername-data-options-value)
    - [`sendThrottled(name, data, options, seconds, key)`](#sendthrottledname-data-options-seconds-key)
    - [`sendDebounced(name, data, options, seconds, key)`](#senddebouncedname-data-options-seconds-key)
  - [`insert(name, Job[])`](#insertname-job)
  - [`fetch(name, options)`](#fetchname-options)
  - [`work()`](#work)
    - [`work(name, options, handler)`](#workname-options-handler)
    - [`work(name, handler)`](#workname-handler)
  - [`notifyWorker(id)`](#notifyworkerid)
  - [`offWork(value)`](#offworkvalue)
  - [`publish(event, data, options)`](#publishevent-data-options)
  - [`subscribe(event, name)`](#subscribeevent-name)
  - [`unsubscribe(event, name)`](#unsubscribeevent-name)
  - [Scheduling](#scheduling)
    - [`schedule(name, cron, data, options)`](#schedulename-cron-data-options)
    - [`unschedule(name)`](#unschedulename)
    - [`getSchedules()`](#getschedules)
  - [`deleteJob(name, id, options)`](#deletejobname-id-options)
  - [`deleteJob(name, [ids], options)`](#deletejobname-ids-options)
  - [`cancel(name, id, options)`](#cancelname-id-options)
  - [`cancel(name, [ids], options)`](#cancelname-ids-options)
  - [`resume(name, id, options)`](#resumename-id-options)
  - [`resume(name, [ids], options)`](#resumename-ids-options)
  - [`complete(name, id, data, options)`](#completename-id-data-options)
  - [`complete(name, [ids], options)`](#completename-ids-options)
  - [`fail(name, id, data, options)`](#failname-id-data-options)
  - [`fail(name, [ids], options)`](#failname-ids-options)
  - [`getJobById(name, id, options)`](#getjobbyidname-id-options)
  - [`createQueue(name, Queue)`](#createqueuename-queue)
  - [`updateQueue(name, options)`](#updatequeuename-options)
  - [`dropQueuedJobs(name)`](#dropqueuedjobsname)
  - [`dropStoredJobs(name)`](#dropstoredjobsname)
  - [`dropAllJobs(name)`](#dropalljobsname)
  - [`deleteQueue(name)`](#deletequeuename)
  - [`getQueues()`](#getqueues)
  - [`getQueue(name)`](#getqueuename)
  - [`getQueueSize(name, options)`](#getqueuesizename-options)
  - [`clearStorage()`](#clearstorage)
  - [`isInstalled()`](#isinstalled)
  - [`schemaVersion()`](#schemaversion)

<!-- /TOC -->

# Intro
pg-boss is a job queue powered by Postgres, operated by 1 or more Node.js instances.

pg-boss relies on [SKIP LOCKED](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/), a feature built specifically for message queues to resolve record locking challenges inherent with relational databases. This provides exactly-once delivery and the safety of guaranteed atomic commits to asynchronous job processing.

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (SQL, querying, and backups). It will be especially useful to those already relying on PostgreSQL that want to limit how many systems are required to monitor and support in their architecture.

Internally, pg-boss uses declarative list-based partitioning to create a physical table per queue within 1 logical job table. This partitioning strategy is a balance between global maintenance operations, queue storage isolation, and query plan optimization. According to [the docs](https://www.postgresql.org/docs/13/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-BEST-PRACTICES), this strategy should scale to thousands of queues. If your usage exceeds this and you experience performance issues, consider grouping queues into separate schemas in the target database.

You may use as many Node.js instances as desired to connect to the same Postgres database, even running it inside serverless functions if needed. Each instance maintains a client-side connection pool or you can substitute your own database client, limited to the maximum number of connections your database server (or server-side connection pooler) can accept. If you find yourself needing even more connections, pg-boss can easily be used behind your custom web API.

## Job states

All jobs start out in the `created` state and become `active` via [`fetch(name, options)`](#fetchname-options) or in a polling worker via [`work()`](#work). 

In a worker, when your handler function completes, jobs will be marked `completed` automatically unless previously deleted via [`deleteJob(name, id)`](#deletejobname-id-options). If an unhandled error is thrown in your handler, the job will usually enter the `retry` state, and then the `failed` state once all retries have been attempted. 

Uncompleted jobs may also be assigned to `cancelled` state via [`cancel(name, id)`](#cancelname-id-options), where they can be moved back into `created` via [`resume(name, id)`](#resumename-id-options).

All jobs that are `completed`, `cancelled` or `failed` become eligible for archiving according to your configuration. Once archived, jobs will be automatically deleted after the configured retention period.

# Database install

pg-boss is usually installed into a dedicated schema in the target database.  When started, it will automatically create this schema and all required storage objects (requires the [CREATE](http://www.postgresql.org/docs/13/static/sql-grant.html) privilege).

```sql
GRANT CREATE ON DATABASE db1 TO leastprivuser;
```

If the CREATE privilege is not available or desired, you can use the included [static functions](#static-functions) to export the SQL commands to manually create or upgrade the required database schema.  **This means you will also need to monitor future releases for schema changes** (the schema property in [version.json](../version.json)) so they can be applied manually.

NOTE: Using an existing schema is supported for advanced use cases **but discouraged**, as this opens up the possibility that creation will fail on an object name collision, and it will add more steps to the uninstallation process.

# Database uninstall

If you need to uninstall pg-boss from a database, just run the following command.

```sql
DROP SCHEMA $1 CASCADE
```

Where `$1` is the name of your schema if you've customized it.  Otherwise, the default schema is `pgboss`.

NOTE: If an existing schema was used during installation, created objects will need to be removed manually using the following commands.

```sql
DROP TABLE pgboss.version;
DROP TABLE pgboss.job;
DROP TYPE pgboss.job_state;
DROP TABLE pgboss.subscription;
DROP TABLE pgboss.schedule;
DROP FUNCTION pgboss.create_queue;
DROP FUNCTION pgboss.delete_queue;
DROP TABLE pgboss.queue;
```

# Direct database interactions

If you need to interact with pg-boss outside of Node.js, such as other clients or even using triggers within PostgreSQL itself, most functionality is supported even when working directly against the internal tables.  Additionally, you may even decide to do this within Node.js. For example, if you wanted to bulk load jobs into pg-boss and skip calling `send()` or `insert()`, you could use SQL `INSERT` or `COPY` commands.

## Job table

The following command is the definition of the primary job table. For manual job creation, the only required column is `name`.  All other columns are nullable or have defaults.

```sql
CREATE TABLE pgboss.job (
  id uuid not null default gen_random_uuid(),
  name text not null,
  priority integer not null default(0),
  data jsonb,
  state pgboss.job_state not null default('created'),
  retry_limit integer not null default(2),
  retry_count integer not null default(0),
  retry_delay integer not null default(0),
  retry_backoff boolean not null default false,
  start_after timestamp with time zone not null default now(),
  started_on timestamp with time zone,
  singleton_key text,
  singleton_on timestamp without time zone,
  expire_in interval not null default interval '15 minutes',
  created_on timestamp with time zone not null default now(),
  completed_on timestamp with time zone,
  keep_until timestamp with time zone NOT NULL default now() + interval '14 days',
  output jsonb,
  policy text,
  CONSTRAINT job_pkey PRIMARY KEY (name, id)
) PARTITION BY LIST (name)
```

# Events

Each pg-boss instance is an EventEmitter, and contains the following events.

## `error`
The `error` event could be raised during internal processing, such as scheduling and maintenance. Adding a listener to the error event is strongly encouraged because of the default behavior of Node.

> If an EventEmitter does not have at least one listener registered for the 'error' event, and an 'error' event is emitted, the error is thrown, a stack trace is printed, and the Node.js process exits.
>
>Source: [Node.js Events > Error Events](https://nodejs.org/api/events.html#events_error_events)

Ideally, code similar to the following example would be used after creating your instance, but before `start()` is called.

```js
boss.on('error', error => logger.error(error));
```

## `wip`

Emitted at most once every 2 seconds when workers are receiving jobs. The payload is an array that represents each worker in this instance of pg-boss.

```js
[
  {
    id: 'fc738fb0-1de5-4947-b138-40d6a790749e',
    name: 'my-queue',
    options: { pollingInterval: 2000 },
    state: 'active',
    count: 1,
    createdOn: 1620149137015,
    lastFetchedOn: 1620149137015,
    lastJobStartedOn: 1620149137015,
    lastJobEndedOn: null,
    lastJobDuration: 343
    lastError: null,
    lastErrorOn: null
  }
]
```

## `stopped`

Emitted after `stop()` once all workers have completed their work and maintenance has been shut down.

# Static functions

The following static functions are not required during normal operations, but are intended to assist in schema creation or migration if run-time privileges do not allow schema changes.

## `string getConstructionPlans(schema)`

**Arguments**
- `schema`: string, database schema name

Returns the SQL commands required for manual creation of the required schema.

## `string getMigrationPlans(schema, version)`

**Arguments**
- `schema`: string, database schema name
- `version`: string, target schema version to migrate

Returns the SQL commands required to manually migrate from the specified version to the latest version.

## `string getRollbackPlans(schema, version)`

**Arguments**
- `schema`: string, database schema name
- `version`: string, target schema version to uninstall

Returns the SQL commands required to manually roll back the specified version to the previous version

# Functions

## `new(connectionString)`

Passing a string argument to the constructor implies a PostgreSQL connection string in one of the formats specified by the [pg](https://github.com/brianc/node-postgres) package.  Some examples are currently posted in the [pg docs](https://github.com/brianc/node-postgres/wiki/pg).

```js
const boss = new PgBoss('postgres://user:pass@host:port/database?ssl=require');
```

## `new(options)`

The following options can be set as properties in an object for additional configurations.

**Connection options**

* **host** - string,  defaults to "127.0.0.1"

* **port** - int,  defaults to 5432

* **ssl** - boolean or object

* **database** - string, *required*

* **user** - string, *required*

* **password** - string

* **connectionString** - string

  PostgreSQL connection string will be parsed and used instead of `host`, `port`, `ssl`, `database`, `user`, `password`.

* **max** - int, defaults to 10

  Maximum number of connections that will be shared by all operations in this instance

* **application_name** - string, defaults to "pgboss"

* **db** - object

    Passing an object named db allows you "bring your own database connection". This option may be beneficial if you'd like to use an existing database service with its own connection pool. Setting this option will bypass the above configuration.

    The expected interface is a function named `executeSql` that allows the following code to run without errors.


    ```js
    const text = "select $1 as input"
    const values = ['arg1']

    const { rows } = await executeSql(text, values)

    assert(rows[0].input === 'arg1')
    ```

* **schema** - string, defaults to "pgboss"

    Database schema that contains all required storage objects. Only alphanumeric and underscore allowed, length: <= 50 characters


**Maintenance options**

Maintenance operations include checking active jobs for expiration, archiving completed jobs from the primary job table, and deleting archived jobs from the archive table.

* **supervise**, bool, default true

  If this is set to false, maintenance and monitoring operations will be disabled on this instance.  This is an advanced use case, as bypassing maintenance operations is not something you would want to do under normal circumstances.

* **schedule**, bool, default true

  If this is set to false, this instance will not monitor or created scheduled jobs during. This is an advanced use case you may want to do for testing or if the clock of the server is skewed and you would like to disable the skew warnings.

* **migrate**, bool, default true

  If this is set to false, this instance will skip attempts to run schema migratations during `start()`. If schema migrations exist, `start()` will throw and error and block usage. This is an advanced use case when the configured user account does not have schema mutation privileges.


**Maintenance interval**

How often maintenance operations are run against the job and archive tables.

* **maintenanceIntervalSeconds**, int

    maintenance interval in seconds, must be >=1


* Default: 1 minute



## `start()`

Returns the same PgBoss instance used during invocation

Prepares the target database and begins job monitoring.

```js
await boss.start()
await boss.send('hey-there', { msg:'this came for you' })
```

If the required database objects do not exist in the specified database, **`start()` will automatically create them**. The same process is true for updates as well. If a new schema version is required, pg-boss will automatically migrate the internal storage to the latest installed version.

> While this is most likely a welcome feature, be aware of this during upgrades since this could delay the promise resolution by however long the migration script takes to run against your data.  For example, if you happened to have millions of jobs in the job table just hanging around for archiving and the next version of the schema had a couple of new indexes, it may take a few seconds before `start()` resolves. Most migrations are very quick, however, and are designed with performance in mind.

Additionally, all schema operations, both first-time provisioning and migrations, are nested within advisory locks to prevent race conditions during `start()`. Internally, these locks are created using `pg_advisory_xact_lock()` which auto-unlock at the end of the transaction and don't require a persistent session or the need to issue an unlock. 

One example of how this is useful would be including `start()` inside the bootstrapping of a pod in a ReplicaSet in Kubernetes. Being able to scale up your job processing using a container orchestration tool like k8s is becoming more and more popular, and pg-boss can be dropped into this system without any special startup handling.

## `stop(options)`

Stops all background processing, such as maintenance and scheduling, as well as all polling workers started with `work()`.

By default, calling `stop()` without any arguments will gracefully wait for all workers to finish processing active jobs before resolving. Emits a `stopped` event if needed.

**Arguments**

* `options`: object

  * `wait`, bool
    Default: `true`. If `true`, the promise won't be resolved until all workers and maintenance jobs are finished.

  * `graceful`, bool

    Default: `true`. If `true`, the PgBoss instance will wait for any workers that are currently processing jobs to finish, up to the specified timeout. During this period, new jobs will not be processed, but active jobs will be allowed to finish.

  * `close`, bool
    Default: `true`. If the database connection is managed by pg-boss, it will close the connection pool. Use `false` if needed to continue allowing operations such as `send()` and `fetch()`.

  * `timeout`, int

    Default: 30000. Maximum time (in milliseconds) to wait for workers to finish job processing before shutting down the PgBoss instance.


## `send()`

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

* Default: 15 minutes

**Retention options**

* **retentionSeconds**, number

    How many seconds a job may be in created or retry state before it's archived. Must be >=1

* Default: 30 days

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

## `insert(name, Job[])`

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
}
```

## `fetch(name, options)`

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

## `work()`

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

* **includeMetadata**, bool, *(default=true)*

  Same as in [`fetch()`](#fetch)

* **priority**, bool, *(default=true)*

  Same as in [`fetch()`](#fetch)

* **pollingIntervalSeconds**, int, *(default=2)*

  Interval to check for new jobs in seconds, must be >=0.5 (500ms)


**Handler function**

`handler` should return a promise (Usually this is an `async` function). If an unhandled error occurs in a handler, `fail()` will automatically be called for the jobs, storing the error in the `output` property, making the job or jobs available for retry.

The jobs argument is an array of jobs with the following properties.

| Prop | Type | |
| - | - | -|
|`id`| string, uuid |
|`name`| string |
|`data`| object |


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

## `notifyWorker(id)`

Notifies a worker by id to bypass the job polling interval (see `pollingIntervalSeconds`) for this iteration in the loop.


## `offWork(value)`

Removes a worker by name or id and stops polling.

** Arguments **
- value: string or object

  If a string, removes all workers found matching the name.  If an object, only the worker with a matching `id` will be removed.

## `publish(event, data, options)`

Publish an event with optional data and options (Same as `send()` args). Looks up all subscriptions for the event and sends to each queue.

## `subscribe(event, name)`

Subscribe queue `name` to `event`.

## `unsubscribe(event, name)`

Remove the subscription of queue `name` to `event`.

## Scheduling

Jobs may be created automatically based on a cron expression. As with other cron-based systems, at least one instance needs to be running for scheduling to work. In order to reduce the amount of evaluations, schedules are checked every 30 seconds, which means the 6-placeholder format should be discouraged in favor of the minute-level precision 5-placeholder format.

For example, use this format, which implies "any second during 3:30 am every day"

```
30 3 * * *
```

but **not** this format which is parsed as "only run exactly at 3:30:30 am every day"

```
30 30 3 * * *
```

To change how often schedules are checked, you can set `cronMonitorIntervalSeconds`. To change how often cron jobs are run, you can set `cronWorkerIntervalSeconds`.

In order mitigate clock skew and drift, every 10 minutes the clocks of each instance are compared to the database server's clock. The skew, if any, is stored and used as an offset during cron evaluation to ensure all instances are synchronized. Internally, job throttling options are then used to make sure only 1 job is sent even if multiple instances are running.

If needed, the default clock monitoring interval can be adjusted using `clockMonitorIntervalSeconds` or `clockMonitorIntervalMinutes`. Additionally, to disable scheduling on an instance completely, use the following in the constructor options.

```js
{
  schedule: false
}
```

For more cron documentation and examples see the docs for the [cron-parser package](https://www.npmjs.com/package/cron-parser).

### `schedule(name, cron, data, options)`

Schedules a job to be sent to the specified queue based on a cron expression. If the schedule already exists, it's updated to the new cron expression.

**Arguments**

- `name`: string, *required*
- `cron`: string, *required*
- `data`: object
- `options`: object

`options` supports all properties in `send()` and an optional `tz` property that specifies a time zone name. If not specified, the default is UTC.

For example, the following code will send a job at 3:00am in the US central time zone into the queue `notification-abc`.

```js
await boss.schedule('notification-abc', `0 3 * * *`, null, { tz: 'America/Chicago' })
```

### `unschedule(name)`

Removes a schedule by queue name.

### `getSchedules()`

Retrieves an array of all scheduled jobs currently being monitored.

## `deleteJob(name, id, options)`

Deletes a job by id.

> Job deletion is offered if desired for a "fetch then delete" workflow similar to SQS. This is not the default behavior for workers so "everything just works" by default, including job throttling and debouncing, which requires jobs to exist to enforce a unique constraint. For example, if you are debouncing a queue to "only allow 1 job per hour", deleting jobs after processing would re-open that time slot, breaking your throttling policy. 

## `deleteJob(name, [ids], options)`

Deletes a set of jobs by id.

## `cancel(name, id, options)`

Cancels a pending or active job.

## `cancel(name, [ids], options)`

Cancels a set of pending or active jobs.

When passing an array of ids, it's possible that the operation may partially succeed based on the state of individual jobs requested. Consider this a best-effort attempt. 

## `resume(name, id, options)`

Resumes a cancelled job.

## `resume(name, [ids], options)`

Resumes a set of cancelled jobs.

## `complete(name, id, data, options)`

Completes an active job. This would likely only be used with `fetch()`. Accepts an optional `data` argument.

The promise will resolve on a successful completion, or reject if the job could not be completed.

## `complete(name, [ids], options)`

Completes a set of active jobs.

The promise will resolve on a successful completion, or reject if not all of the requested jobs could not be marked as completed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.

## `fail(name, id, data, options)`

Marks an active job as failed.

The promise will resolve on a successful assignment of failure, or reject if the job could not be marked as failed.

## `fail(name, [ids], options)`

Fails a set of active jobs.

The promise will resolve on a successful failure state assignment, or reject if not all of the requested jobs could not be marked as failed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.


## `getJobById(name, id, options)`

Retrieves a job with all metadata by name and id

**options**

* `includeArchive`: bool, default: false

  If `true`, it will search for the job in the archive if not found in the primary job storage.

## `createQueue(name, Queue)`

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


## `updateQueue(name, options)`

Updates options on an existing queue. The policy can be changed, but understand this won't impact existing jobs in flight and will only apply the new policy on new incoming jobs.

## `dropQueuedJobs(name)`

Deletes all queued jobs in a queue.

## `dropStoredJobs(name)`

Deletes all jobs in completed, failed, and cancelled state in a queue.

## `dropAllJobs(name)`

Deletes all jobs in a queue, including active jobs.


## `deleteQueue(name)`

Deletes a queue and all jobs from the active job table.  Any jobs in the archive table are retained.

## `getQueues()`

Returns all queues

## `getQueue(name)`

Returns a queue by name

## `getQueueSize(name, options)`

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

## `clearStorage()`

Utility function if and when needed to clear all job and archive storage tables. Internally, this issues a `TRUNCATE` command.

## `isInstalled()`

Utility function to see if pg-boss is installed in the configured database.

## `schemaVersion()`

Utility function to get the database schema version.
