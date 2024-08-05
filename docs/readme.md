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
  - [`monitor-states`](#monitor-states)
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
    - [`sendAfter(name, data, options, seconds | ISO date string | Date)`](#sendaftername-data-options-seconds--iso-date-string--date)
    - [`sendThrottled(name, data, options, seconds [, key])`](#sendthrottledname-data-options-seconds--key)
    - [`sendDebounced(name, data, options, seconds [, key])`](#senddebouncedname-data-options-seconds--key)
  - [`insert([jobs])`](#insertjobs)
  - [`fetch()`](#fetch)
    - [`fetch(name)`](#fetchname)
    - [`fetch(name, batchSize, [, options])`](#fetchname-batchsize--options)
  - [`work()`](#work)
    - [`work(name [, options], handler)`](#workname--options-handler)
  - [`offWork(value)`](#offworkvalue)
  - [`publish(event, data, options)`](#publishevent-data-options)
  - [`subscribe(event, name)`](#subscribeevent-name)
  - [`unsubscribe(event, name)`](#unsubscribeevent-name)
  - [Scheduling](#scheduling)
    - [`schedule(name, cron, data, options)`](#schedulename-cron-data-options)
    - [`unschedule(name)`](#unschedulename)
    - [`getSchedules()`](#getschedules)
  - [`cancel(name, id, options)`](#cancelname-id-options)
  - [`cancel(name, [ids], options)`](#cancelname-ids-options)
  - [`resume(name, id, options)`](#resumename-id-options)
  - [`resume(name, [ids], options)`](#resumename-ids-options)
  - [`complete(name, id [, data, options])`](#completename-id--data-options)
  - [`complete(name, [ids], options)`](#completename-ids-options)
  - [`fail(name, id [, data, options])`](#failname-id--data-options)
  - [`fail(name, [ids], options)`](#failname-ids-options)
  - [`notifyWorker(id)`](#notifyworkerid)
  - [`getQueueSize(name [, options])`](#getqueuesizename--options)
  - [`getJobById(name, id, options)`](#getjobbyidname-id-options)
  - [`createQueue(name, Queue)`](#createqueuename-queue)
  - [`deleteQueue(name)`](#deletequeuename)
  - [`clearStorage()`](#clearstorage)
  - [`isInstalled()`](#isinstalled)
  - [`schemaVersion()`](#schemaversion)

<!-- /TOC -->

# Intro
pg-boss is a job queue powered by Postgres, operated by 1 or more Node.js instances.

Architecturally, pg-boss is similar to queue products such as AWS SQS, which primarily acts as a store of jobs that are "pulled", not "pushed" from the server. For example, pg-boss handles job timeouts and retries similar to the SQS message visibility timeout. [SKIP LOCKED](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5) guarantees exactly-once delivery, which is only available in SQS via FIFO queues (with the caveat of their throughput limitations). Keep in mind that exactly-once delivery is not a guarantee that a job will never be processed more than once because of retries, so keep the general recommendation for idempotency with queueing systems in mind.

pg-boss uses declarative list-based partitioning for queue storage (each queue creates a dedicated child table that is attached to the parent partitioned job table). This partitioning strategy is a balance between maintenance operations (there is only 1 logical table to manage) and queue isolation. Physical queue isolation prevents volume spikes and backlogs in a queue from affecting the performance of other queues. This should address the majority of systems that involve < 10,000 distinct queues. If your usage exceeds this and you experience performance issues, consider spreading your queues across  multiple pg-boss instances, each connected to a different schema in the target database.

You may use as many Node.js instances as desired to connect to Postgres and scale workers out. Each instance maintains a connection pool or you can bring your own, limited to the maximum number of connections your database server can accept. 
If you find yourself needing even more connections, pg-boss is also compatible with common server-side connection poolers such as pgBouncer.

## Job states

All jobs start out in the `created` state and become `active` when picked up for work. If job processing completes successfully, jobs will go to `completed`. If a job fails, it will typcially enter the `failed` state. However, if a job has retry options configured, it will enter the `retry` state on failure instead and have a chance to re-enter `active` state. Jobs can also enter `cancelled` state via [`cancel(name, id)`](#cancelname-id-options) or [`cancel(name, [ids])`](#cancelname-ids-options).

All jobs that are `completed`, `cancelled` or `failed` become eligible for archiving (i.e. they will transition into the `archive` state) after the configured `archiveCompletedAfterSeconds` time. Once archived, jobs will be automatically deleted after the configured deletion period.

# Database install

pg-boss can be installed into any database.  When started, it will detect if it is installed and automatically create required storage.  Automatic creation requires the [CREATE](http://www.postgresql.org/docs/9.5/static/sql-grant.html) privilege in order to create and maintain its schema.

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
DROP TABLE pgboss.archive;
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
  retry_limit integer not null default(0),
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
  dead_letter text,
  policy text,
  CONSTRAINT job_pkey PRIMARY KEY (name, id)
) PARTITION BY LIST (name)
```

# Events

Each instance of pg-boss is an EventEmitter.  You can run multiple instances of pg-boss for a variety of use cases including distribution and load balancing. Each instance has the freedom to process to whichever jobs you need.  Because of this diversity, the job activity of one instance could be drastically different from another.

> For example, if you were to process to `error` in instance A, it will not receive an `error` event from instance B.

## `error`
The error event is raised from any errors that may occur during internal job fetching, monitoring and archiving activities. While not required, adding a listener to the error event is strongly encouraged:

> If an EventEmitter does not have at least one listener registered for the 'error' event, and an 'error' event is emitted, the error is thrown, a stack trace is printed, and the Node.js process exits.
>
>Source: [Node.js Events > Error Events](https://nodejs.org/api/events.html#events_error_events)

Ideally, code similar to the following example would be used after creating your instance, but before `start()` is called.

```js
boss.on('error', error => logger.error(error));
```

> **Note: Since error events are only raised during internal housekeeping activities, they are not raised for direct API calls.**

## `monitor-states`

The `monitor-states` event is conditionally raised based on the `monitorStateInterval` configuration setting and only emitted from `start()`. If passed during instance creation, it will provide a count of jobs in each state per interval.  This could be useful for logging or even determining if the job system is handling its load.

The payload of the event is an object with a key per queue and state, such as the  following example.

```json
{
  "queues": {
      "send-welcome-email": {
        "created": 530,
        "retry": 40,
        "active": 26,
        "completed": 3400,
        "cancelled": 0,
        "failed": 49,
        "all": 4049
      },
      "archive-cleanup": {
        "created": 0,
        "retry": 0,
        "active": 0,
        "completed": 645,
        "cancelled": 0,
        "failed": 0,
        "all": 645
      }
  },
  "created": 530,
  "retry": 40,
  "active": 26,
  "completed": 4045,
  "cancelled": 0,
  "failed": 4,
  "all": 4694
}
```
## `wip`

Emitted at most once every 2 seconds when workers are active and jobs are entering or leaving active state. The payload is an array that represents each worker in this instance of pg-boss.  If you want to monitor queue activity across all instances, use `monitor-states`.

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


**Queue options**

Queue options contain the following constructor-only settings.

* **archiveCompletedAfterSeconds**

    Specifies how long in seconds completed jobs get archived. Note: a warning will be emitted if set to lower than 60s and cron processing will be disabled.

  Default: 12 hours

* **archiveFailedAfterSeconds**

    Specifies how long in seconds failed jobs get archived. Note: a warning will be emitted if set to lower than 60s and cron processing will be disabled.

  Default: `archiveCompletedAfterSeconds`

**Monitoring options**

* **monitorStateIntervalSeconds** - int, default undefined

    Specifies how often in seconds an instance will fire the `monitor-states` event. Must be >= 1.

* **monitorStateIntervalMinutes** - int, default undefined

    Specifies how often in minutes an instance will fire the `monitor-states` event. Must be >= 1.

  > When a higher unit is is specified, lower unit configuration settings are ignored.


**Maintenance options**

Maintenance operations include checking active jobs for expiration, archiving completed jobs from the primary job table, and deleting archived jobs from the archive table.

* **supervise**, bool, default true

  If this is set to false, maintenance and monitoring operations will be disabled on this instance.  This is an advanced use case, as bypassing maintenance operations is not something you would want to do under normal circumstances.

* **schedule**, bool, default true

  If this is set to false, this instance will not monitor or created scheduled jobs during. This is an advanced use case you may want to do for testing or if the clock of the server is skewed and you would like to disable the skew warnings.

* **migrate**, bool, default true

  If this is set to false, this instance will skip attempts to run schema migratations during `start()`. If schema migrations exist, `start()` will throw and error and block usage. This is an advanced use case when the configured user account does not have schema mutation privileges.

**Archive options**

When jobs in the archive table become eligible for deletion.

* **deleteAfterSeconds**, int

    delete interval in seconds, must be >=1

* **deleteAfterMinutes**, int

    delete interval in minutes, must be >=1

* **deleteAfterHours**, int

    delete interval in hours, must be >=1

* **deleteAfterDays**, int

    delete interval in days, must be >=1

* Default: 7 days

  > When a higher unit is is specified, lower unit configuration settings are ignored.

**Maintenance interval**

How often maintenance operations are run against the job and archive tables.

* **maintenanceIntervalSeconds**, int

    maintenance interval in seconds, must be >=1

* **maintenanceIntervalMinutes**, int

    interval in minutes, must be >=1

* Default: 1 minute

  > When a higher unit is is specified, lower unit configuration settings are ignored.


## `start()`

Returns the same PgBoss instance used during invocation

Prepares the target database and begins job monitoring.

```js
await boss.start()
await boss.send('hey-there', { msg:'this came for you' })
```

If the required database objects do not exist in the specified database, **`start()` will automatically create them**. The same process is true for updates as well. If a new schema version is required, pg-boss will automatically migrate the internal storage to the latest installed version.

> While this is most likely a welcome feature, be aware of this during upgrades since this could delay the promise resolution by however long the migration script takes to run against your data.  For example, if you happened to have millions of jobs in the job table just hanging around for archiving and the next version of the schema had a couple of new indexes, it may take a few seconds before `start()` resolves. Most migrations are very quick, however, and are designed with performance in mind.

Additionally, all schema operations, both first-time provisioning and migrations, are nested within advisory locks to prevent race conditions during `start()`. Internally, these locks are created using `pg_advisory_xact_lock()` which auto-unlock at the end of the transaction and don't require a persistent session or the need to issue an unlock. This should make it compatible with most connection poolers, such as pgBouncer in transactional pooling mode.

One example of how this is useful would be including `start()` inside the bootstrapping of a pod in a ReplicaSet in Kubernetes. Being able to scale up your job processing using a container orchestration tool like k8s is becoming more and more popular, and pg-boss can be dropped into this system with no additional logic, fear, or special configuration.

## `stop(options)`

All job monitoring will be stopped and all workers on this instance will be removed. Basically, it's the opposite of `start()`. Even though `start()` may create new database objects during initialization, `stop()` will never remove anything from the database.

By default, calling `stop()` without any arguments will gracefully wait for all workers to finish processing active jobs before closing the internal connection pool and stopping maintenance operations. This behaviour can be configured using the stop options object. In graceful stop mode, the promise returned by `stop()` will still be resolved immediately.  If monitoring for the end of the stop is needed, add a listener to the `stopped` event.

**Arguments**

* `options`: object

  * `destroy`, bool
    Default: `false`. If `true` and the database connection is managed by pg-boss, it will destroy the connection pool.

  * `graceful`, bool

    Default: `true`. If `true`, the PgBoss instance will wait for any workers that are currently processing jobs to finish, up to the specified timeout. During this period, new jobs will not be processed, but active jobs will be allowed to finish.

  * `timeout`, int

    Default: 30000. Maximum time (in milliseconds) to wait for workers to finish job processing before shutting down the PgBoss instance.


## `send()`

Creates a new job and resolves the job's unique identifier (uuid).

> `send()` will resolve a `null` for job id under some use cases when using unique jobs or throttling (see below).  These options are always opt-in on the send side and therefore don't result in a promise rejection.

### `send(name, data, options)`

**Arguments**

- `name`: string, *required*
- `data`: object
- `options`: object


**General options**

* **priority**, int

    optional priority.  Higher numbers have, um, higher priority

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
  A wrapper object containing an async method called `executeSql` that performs the query to the db. Can be used to manage jobs inside a transaction. Example:

    ```
    const db = {
      async executeSql (sql, values) {
        return trx.query(sql, values)
      }
    }
    ```

**Deferred jobs**

* **startAfter** int, string, or Date
  * int: seconds to delay starting the job
  * string: Start after a UTC Date time string in 8601 format
  * Date: Start after a Date object

    Default: 0

**Unique jobs**

* **singletonKey** string

  Allows a max of 1 job (with the same name and singletonKey) to be queued or active.

  ```js
  boss.send('my-job', {}, {singletonKey: '123'}) // resolves a jobId
  boss.send('my-job', {}, {singletonKey: '123'}) // resolves a null jobId until first job completed
  ```

**Throttled jobs**

* **singletonSeconds**, int
* **singletonMinutes**, int
* **singletonHours**, int
* **singletonNextSlot**, bool

Throttling jobs to 'once every n units', where units could be seconds, minutes, or hours.  This option is set on the send side of the API since jobs may or may not be created based on the existence of other jobs.

For example, if you set the `singletonMinutes` to 1, then submit 2 jobs within a minute, only the first job will be accepted and resolve a job id.  The second request will be discarded, but resolve a null instead of an id.

> When a higher unit is is specified, lower unit configuration settings are ignored.

Setting `singletonNextSlot` to true will cause the job to be scheduled to run after the current time slot if and when a job is throttled. This option is set to true, for example, when calling the convenience function `sendDebounced()`.

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

### `sendAfter(name, data, options, seconds | ISO date string | Date)`

Send a job that should start after a number of seconds from now, or after a specific date time.

This is a convenience version of `send()` with the `startAfter` option assigned.


### `sendThrottled(name, data, options, seconds [, key])`

Only allows one job to be sent to the same queue within a number of seconds.  In this case, the first job within the interval is allowed, and all other jobs within the same interval are rejected.

This is a convenience version of `send()` with the `singletonSeconds` and `singletonKey` option assigned. The `key` argument is optional.

### `sendDebounced(name, data, options, seconds [, key])`

Like, `sendThrottled()`, but instead of rejecting if a job is already sent in the current interval, it will try to add the job to the next interval if one hasn't already been sent.

This is a convenience version of `send()` with the `singletonSeconds`, `singletonKey` and `singletonNextSlot` option assigned. The `key` argument is optional.

## `insert([jobs])`

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


## `fetch()`

Typically one would use `work()` for automated polling for new jobs based upon a reasonable interval to finish the most jobs with the lowest latency. While `work()` is a yet another free service we offer and it can be awfully convenient, sometimes you may have a special use case around when a job can be retrieved. Or, perhaps like me, you need to provide jobs via other entry points such as a web API.

`fetch()` allows you to skip all that polling nonsense that `work()` does and puts you back in control of database traffic. Once you have your shiny job, you'll use either `complete()` or `fail()` to mark it as finished.

### `fetch(name)`

**Arguments**
- `name`: string

**Resolves**
- `job`: job object, `null` if none found

### `fetch(name, batchSize, [, options])`

**Arguments**
- `name`: string
- `batchSize`: number, # of jobs to fetch
- `options`: object

  * `priority`, bool, default: `true`

    If true, allow jobs with a higher priority to be fetched before jobs with lower or no priority

  * `includeMetadata`, bool, default: `false`

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

**Resolves**
- `[job]`: array of job objects, `null` if none found

**Notes**

If you pass a batchSize, `fetch()` will always resolve an array response, even if only 1 job is returned. This seemed like a great idea at the time.

The following code shows how to utilize batching via `fetch()` to get and complete 20 jobs at once on-demand.


```js
const queue = 'email-daily-digest'
const batchSize = 20

const jobs = await boss.fetch(queue, batchSize)

if(!jobs) {
    return
}

for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]

    try {
        await emailer.send(job.data)
        await boss.complete(job.id)
    } catch(err) {
        await boss.fail(job.id, err)
    }
}
```

## `work()`

Adds a new polling worker for a queue and executes the provided callback function when jobs are found. Multiple workers can be added if needed.

Workers can be stopped via `offWork()` all at once by queue name or individually by using the unique id resolved by `work()`. Workers may be monitored by listening to the `wip` event.

The default concurrency for `work()` is 1 job every 2 seconds. Both the interval and the number of jobs per interval can be changed globally or per-queue with configuration options.

### `work(name [, options], handler)`

**Arguments**
- `name`: string, *required*
- `options`: object
- `handler`: function(job), *required*

**Options**

* **teamSize**, int

    Default: 1. How many jobs can be fetched per polling interval. Callback will be executed once per job.

* **teamConcurrency**, int

    Default: 1. How many callbacks will be called concurrently if promises are used for polling backpressure. Intended to be used along with `teamSize`.

* **teamRefill**, bool

    Default: false.  If true, worker will refill the queue based on the number of completed jobs from the last batch (if `teamSize` > 1) in order to keep the active job count as close to `teamSize` as possible. This could be helpful if one of the fetched jobs is taking longer than expected.

* **batchSize**, int

    How many jobs can be fetched per polling interval.  Callback will be executed once per batch.

* **includeMetadata**, bool

    Same as in [`fetch()`](#fetch)


**Polling options**

How often workers will poll the queue table for jobs. Available in the constructor as a default or per worker in `work()`.

* **pollingIntervalSeconds**, int

  Interval to check for new jobs in seconds, must be >=0.5 (500ms)

* Default: 2 seconds

  > When a higher unit is is specified, lower unit configuration settings are ignored.


**Handler function**

`handler` should either be an `async` function or return a promise. If an error occurs in the handler, it will be caught and stored into an output storage column in addition to marking the job as failed.

Enforcing promise-returning handlers that are awaited in the workers defers polling for new jobs until the existing jobs are completed, providing backpressure.

The job object has the following properties.

| Prop | Type | |
| - | - | -|
|`id`| string, uuid |
|`name`| string |
|`data`| object |

> If the job is not completed, it will expire after the configured expiration period.

Following is an example of a worker that returns a promise (`sendWelcomeEmail()`) for completion with the teamSize option set for increased job concurrency between polling intervals.

```js
const options = { teamSize: 5, teamConcurrency: 5 }
await boss.work('email-welcome', options, job => myEmailService.sendWelcomeEmail(job.data))
```

Similar to the first example, but with a batch of jobs at once.

```js
await boss.work('email-welcome', { batchSize: 5 },
    jobs => myEmailService.sendWelcomeEmails(jobs.map(job => job.data))
)
```

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

## `cancel(name, id, options)`

Cancels a pending or active job.

The promise will resolve on a successful cancel, or reject if the job could not be cancelled.

## `cancel(name, [ids], options)`

Cancels a set of pending or active jobs.

The promise will resolve on a successful cancel, or reject if not all of the requested jobs could not be cancelled.

> Due to the nature of the use case of attempting a batch job cancellation, it may be likely that some jobs were in flight and even completed during the cancellation request. Because of this, cancellation will cancel as many as possible and reject with a message showing the number of jobs that could not be cancelled because they were no longer active.

## `resume(name, id, options)`

Resumes a cancelled job.

## `resume(name, [ids], options)`

Resumes a set of cancelled jobs.

## `complete(name, id [, data, options])`

Completes an active job.  This would likely only be used with `fetch()`. Accepts an optional `data` argument.

The promise will resolve on a successful completion, or reject if the job could not be completed.

## `complete(name, [ids], options)`

Completes a set of active jobs.

The promise will resolve on a successful completion, or reject if not all of the requested jobs could not be marked as completed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.

## `fail(name, id [, data, options])`

Marks an active job as failed.

The promise will resolve on a successful assignment of failure, or reject if the job could not be marked as failed.

## `fail(name, [ids], options)`

Fails a set of active jobs.

The promise will resolve on a successful failure state assignment, or reject if not all of the requested jobs could not be marked as failed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.

## `notifyWorker(id)`

Notifies a worker by id to bypass the job polling interval (see `pollingIntervalSeconds`) for this iteration in the loop.

## `getQueueSize(name [, options])`

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

## `getJobById(name, id, options)`

Retrieves a job with all metadata by id in either the primary or archive storage.

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
| standard | (Default) Supports all standard features such as deferral, priority, and throttling |
| debounced | All standard features, but only allows 1 job to be queued, unlimited active. Can be extended with `singletonKey` |
| singleton | All standard features, but only allows 1 job to be active, unlimited queued. Can be extended with `singletonKey` |
| stately | Combination of debounced and singleton: Only allows 1 job per state, queued and/or active. Can be extended with `singletonKey` |


## `deleteQueue(name)`

Deletes a queue and all jobs from the active job table.  Any jobs in the archive table are retained.

## `clearStorage()`

Utility function if and when needed to clear all job and archive storage tables. Internally, this issues a `TRUNCATE` command.

## `isInstalled()`

Utility function to see if pg-boss is installed in the configured database.

## `schemaVersion()`

Utility function to get the database schema version.