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
    - [`sendOnce(name, data, options, key)`](#sendoncename-data-options-key)
    - [`sendSingleton(name, data, options)`](#sendsingletonname-data-options)
    - [`sendThrottled(name, data, options, seconds [, key])`](#sendthrottledname-data-options-seconds--key)
    - [`sendDebounced(name, data, options, seconds [, key])`](#senddebouncedname-data-options-seconds--key)
  - [`insert([jobs])`](#insertjobs)
  - [`fetch()`](#fetch)
    - [`fetch(name)`](#fetchname)
    - [`fetch(name, batchSize, [, options])`](#fetchname-batchsize--options)
    - [`fetchCompleted(name [, batchSize] [, options])`](#fetchcompletedname--batchsize--options)
  - [`work()`](#work)
    - [`work(name [, options], handler)`](#workname--options-handler)
    - [`onComplete(name [, options], handler)`](#oncompletename--options-handler)
  - [`offWork(value)`](#offworkvalue)
    - [`offComplete(value)`](#offcompletevalue)
  - [`publish(event, data, options)`](#publishevent-data-options)
  - [`subscribe(event, name)`](#subscribeevent-name)
  - [`unsubscribe(event, name)`](#unsubscribeevent-name)
  - [Scheduling](#scheduling)
    - [`schedule(name, cron, data, options)`](#schedulename-cron-data-options)
    - [`unschedule(name)`](#unschedulename)
    - [`getSchedules()`](#getschedules)
  - [`cancel(id, options)`](#cancelid-options)
  - [`cancel([ids], options)`](#cancelids-options)
  - [`resume(id, options)`](#resumeid-options)
  - [`resume([ids], options)`](#resumeids-options)
  - [`complete(id [, data, options])`](#completeid--data-options)
  - [`complete([ids], options)`](#completeids-options)
  - [`fail(id [, data, options])`](#failid--data-options)
  - [`fail([ids], options)`](#failids-options)
  - [`notifyWorker(id)`](#notifyworkerid)
  - [`getQueueSize(name [, options])`](#getqueuesizename--options)
  - [`getJobById(id, options)`](#getjobbyidid-options)
  - [`deleteQueue(name)`](#deletequeuename)
  - [`deleteAllQueues()`](#deleteallqueues)
  - [`clearStorage()`](#clearstorage)

<!-- /TOC -->

# Intro
pg-boss is a job queue written in Node.js and backed by the reliability of Postgres.

You may use as many instances as needed to connect to the same Postgres database. Each instance maintains a connection pool or you can bring your own, limited to the maximum number of connections your database server can accept. If you need a larger number of workers, consider using a centralized connection pool such as pgBouncer. [Creating your own web API or UI](https://github.com/timgit/pg-boss/issues/266) is another option if direct database access is not available.

If you require multiple installations in the same database, such as for large volume queues, you may wish to specify a separate schema per install to achieve partitioning.

Architecturally, pg-boss is somewhat similar to queue products such as AWS SQS, which primarily acts as a store of jobs that are "pulled", not "pushed" from the server. If at least one pg-boss instance is running, internal maintenance jobs will be periodically run to make sure fetched jobs that are never completed are marked as expired or retried (if configured). If and when this happens, think of a job with a retry configuration to act just like the SQS message visibility timeout. In regards to job delivery, Postgres [SKIP LOCKED](http://blog.2ndquadrant.com/what-is-select-skip-locked-for-in-postgresql-9-5) will guarantee exactly-once, which is only available in SQS via FIFO queues (and its throughput limitations). However, even if you have exactly-once delivery, this is not a guarantee that a job will never be processed more than once if you opt into retries, so keep the general recommendation for idempotency with queueing systems in mind.

## Job states

All jobs start out in the `created` state and become `active` when picked up for work. If job processing completes successfully, jobs will go to `completed`. If a job fails, it will typically enter the `failed` state. However, if a job has retry options configured, it will enter the `retry` state on failure instead and have a chance to re-enter `active` state. It's also possible for `active` jobs to become `expired`, which happens when job processing takes too long. Jobs can also enter `cancelled` state via [`cancel(id)`](#cancelid) or [`cancel([ids])`](#cancelids).

All jobs that are `completed`, `expired`, `cancelled` or `failed` become eligible for archiving (i.e. they will transition into the `archive` state) after the configured `archiveCompletedAfterSeconds` time. Once `archive`d, jobs will be automatically deleted by pg-boss after the configured deletion period.

Here's a state diagram that shows the possible states and their transitions:

![job state diagram](./images/job-states.png)

# Database install

pg-boss can be installed into any database.  When started, it will detect if it is installed and automatically create the required schema for all queue operations if needed.  If the database doesn't already have the pgcrypto extension installed, you will need to have a superuser add it before pg-boss can create its schema.

```sql
CREATE EXTENSION pgcrypto;
```

Once this is completed, pg-boss requires the [CREATE](http://www.postgresql.org/docs/9.5/static/sql-grant.html) privilege in order to create and maintain its schema.

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
DROP TABLE ${schema}.archive;
DROP TABLE ${schema}.job;
DROP TABLE ${schema}.schedule;
DROP TABLE ${schema}.subscription;
DROP TABLE ${schema}.version;
DROP TYPE ${schema}.job_state;
```

# Direct database interactions

If you need to interact with pg-boss outside of Node.js, such as other clients or even using triggers within PostgreSQL itself, most functionality is supported even when working directly against the internal tables.  Additionally, you may even decide to do this within Node.js. For example, if you wanted to bulk load jobs into pg-boss and skip calling `send()` or `insert()`, you could use SQL `INSERT` or `COPY` commands.

## Job table

The following command is the definition of the primary job table. For manual job creation, the only required column is `name`.  All other columns are nullable or have sensible defaults.

```sql
  CREATE TABLE ${schema}.job (
    id uuid primary key not null default gen_random_uuid(),
    name text not null,
    priority integer not null default(0),
    data jsonb,
    state ${schema}.job_state not null default('${states.created}'),
    retryLimit integer not null default(0),
    retryCount integer not null default(0),
    retryDelay integer not null default(0),
    retryBackoff boolean not null default false,
    startAfter timestamp with time zone not null default now(),
    startedOn timestamp with time zone,
    singletonKey text,
    singletonOn timestamp without time zone,
    expireIn interval not null default interval '15 minutes',
    createdOn timestamp with time zone not null default now(),
    completedOn timestamp with time zone,
    keepUntil timestamp with time zone NOT NULL default now() + interval '14 days',
    on_complete boolean not null default true,
    output jsonb
  )
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
        "expired": 4,
        "cancelled": 0,
        "failed": 49,
        "all": 4049
      },
      "archive-cleanup": {
        "created": 0,
        "retry": 0,
        "active": 0,
        "completed": 645,
        "expired": 0,
        "cancelled": 0,
        "failed": 0,
        "all": 645
      }
  },
  "created": 530,
  "retry": 40,
  "active": 26,
  "completed": 4045,
  "expired": 4,
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
    options: { newJobCheckInterval: 2000 },
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
    const text = "select 1 as value1 from table1 where bar = $1"
    const values = ['foo']

    const { rows, rowCount } = await executeSql(text, values)

    assert(rows[0].value1 === 1)
    assert(rowCount === 1)
    ```

* **schema** - string, defaults to "pgboss"

    Database schema that contains all required storage objects. Only alphanumeric and underscore allowed, length: <= 50 characters


**Queue options**

Queue options contain the following constructor-only settings.

* **uuid** - string, defaults to "v4"

    job uuid format used, "v1" or "v4"

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

* **noSupervisor**, bool, default false

  If this is set to true, maintenance and monitoring operations will not be started during a `start()` after the schema is created.  This is an advanced use case, as bypassing maintenance operations is not something you would want to do under normal circumstances.

* **noScheduling**, bool, default false

  If this is set to true, this instance will not monitor scheduled jobs during `start()`. However, this instance can still use the scheduling api. This is an advanced use case you may want to do for testing or if the clock of the server is skewed and you would like to disable the skew warnings.

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

  This can be used in conjunction with throttling explained below.

  * **useSingletonQueue** boolean

    When used in conjunction with singletonKey, allows a max of 1 job to be queued.

    >By default, there is no limit on the number of these jobs that may be active. However, this behavior may be modified by passing the [enforceSingletonQueueActiveLimit](#fetch) option.

  ```js
  boss.send('my-job', {}, {singletonKey: '123', useSingletonQueue: true}) // resolves a jobId
  boss.send('my-job', {}, {singletonKey: '123', useSingletonQueue: true}) // resolves a null jobId until first job becomes active
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

**Completion jobs**

* **onComplete**, bool (Default: false)

When a job completes, a completion job will be created in the queue, copying the same retention policy as the job, for the purpose of `onComplete()` or `fetchCompleted()`.  If completion jobs are not used, they will be archived according to the retention policy.  If the queue in question has a very high volume, this can be set to `false` to bypass creating the completion job.  This can also be set in the constructor as a default for all calls to `send()`.



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

### `sendOnce(name, data, options, key)`

Send a job with a unique key to only allow 1 job to be in created, retry, or active state at a time.

This is a convenience version of `send()` with the `singletonKey` option assigned.

### `sendSingleton(name, data, options)`

Send a job but only allow 1 job to be in created or retry state at at time.

This is a convenience version of `send()` with the `singletonKey` option assigned.

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
  onComplete?: boolean
}
```


## `fetch()`

Typically one would use `work()` for automated polling for new jobs based upon a reasonable interval to finish the most jobs with the lowest latency. While `work()` is a yet another free service we offer and it can be awfully convenient, sometimes you may have a special use case around when a job can be retrieved. Or, perhaps like me, you need to provide jobs via other entry points such as a web API.

`fetch()` allows you to skip all that polling nonsense that `work()` does and puts you back in control of database traffic. Once you have your shiny job, you'll use either `complete()` or `fail()` to mark it as finished.

### `fetch(name)`

**Arguments**
- `name`: string, queue name or pattern

**Resolves**
- `job`: job object, `null` if none found

### `fetch(name, batchSize, [, options])`

**Arguments**
- `name`: string, queue name or pattern
- `batchSize`: number, # of jobs to fetch
- `options`: object

  * `includeMetadata`, bool

    If `true`, all job metadata will be returned on the job object.  The following table shows each property and its type, which is basically all columns from the job table.

    | Prop | Type | |
    | - | - | -|
    | id | string, uuid |
    | name| string |
    | data | object |
    | priority | number |
    | state | string |
    | retrylimit | number |
    | retrycount | number |
    | retrydelay | number |
    | retrybackoff | bool |
    | startafter | string, timestamp |
    | startedon | string, timestamp |
    | singletonkey | string |
    | singletonon | string, timestamp |
    | expirein | object, pg interval |
    | createdon | string, timestamp |
    | completedon | string, timestamp |
    | keepuntil | string, timestamp |
    | oncomplete | bool |
    | output | object |

  * `enforceSingletonQueueActiveLimit`, bool

    If `true`, modifies the behavior of the `useSingletonQueue` flag to allow a max of 1 job to be queued plus a max of 1 job to be active.
    >Note that use of this option can impact performance on instances with large numbers of jobs.


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

### `fetchCompleted(name [, batchSize] [, options])`

Same as `fetch()`, but retrieves any completed jobs. See [`onComplete()`](#oncompletename--options-handler) for more information.
## `work()`

Adds a new polling worker for a queue and executes the provided callback function when jobs are found. Multiple workers can be added if needed.

Workers can be stopped via `offWork()` all at once by queue name or individually by using the unique id resolved by `work()`. Workers may be monitored by listening to the `wip` event.

Queue patterns use the `*` character to match 0 or more characters.  For example, a job from queue `status-report-12345` would be fetched with pattern `status-report-*` or even `stat*5`.

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

* **enforceSingletonQueueActiveLimit**, bool

    Same as in [`fetch()`](#fetch)

**Polling options**

How often workers will poll the queue table for jobs. Available in the constructor as a default or per worker in `work()` and `onComplete()`.

* **newJobCheckInterval**, int

  Interval to check for new jobs in milliseconds, must be >=100

* **newJobCheckIntervalSeconds**, int

  Interval to check for new jobs in seconds, must be >=1

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

### `onComplete(name [, options], handler)`

Sometimes when a job completes, expires or fails, it's important enough to trigger other things that should react to it. `onComplete` works identically to `work()` and was created to facilitate the creation of orchestrations or sagas between jobs that may or may not know about each other. This common messaging pattern allows you to keep multi-job flow logic out of the individual job handlers so you can manage things in a more centralized fashion while not losing your mind. As you most likely already know, asynchronous jobs are complicated enough already. Internally, these jobs have a special prefix of `__state__completed__`.

The callback for `onComplete()` returns a job containing the original job and completion details. `request` will be the original job as submitted with `id`, `name` and `data`. `response` may or may not have a value based on arguments in [complete()](#completeid--data) or [fail()](#failid--data).

Here's an example from the test suite showing this in action.

```js
const jobName = 'onCompleteFtw'
const requestPayload = { token:'trivial' }
const responsePayload = { message: 'so verbose', code: '1234' }

boss.onComplete(jobName, job => {
    assert.strictEqual(jobId, job.data.request.id)
    assert.strictEqual(job.data.request.data.token, requestPayload.token)
    assert.strictEqual(job.data.response.message, responsePayload.message)
    assert.strictEqual(job.data.response.code, responsePayload.code)

    finished() // test suite completion callback
})

const jobId = await boss.send(jobName, requestPayload)
const job = await boss.fetch(jobName)
await boss.complete(job.id, responsePayload)
```

The following is an example data object from the job retrieved in onComplete() above.

```js
{
    "request": {
        "id": "26a608d0-79bf-11e8-8391-653981c16efd",
        "name": "onCompleteFtw",
        "data": {
            "token": "trivial"
        }
    },
    "response": {
        "message": "so verbose",
        "code": "1234"
    },
    "failed": false,
    "state": "completed",
    "createdOn": "2018-06-26T23:04:12.9392-05:00",
    "startedOn": "2018-06-26T23:04:12.945533-05:00",
    "completedOn": "2018-06-26T23:04:12.949092-05:00",
    "retryCount": 0
}
```

## `offWork(value)`

Removes a worker by name or id and stops polling.

** Arguments **
- value: string or object

  If a string, removes all workers found matching the name.  If an object, only the worker with a matching `id` will be removed.

### `offComplete(value)`

Similar to `offWork()`, but removes an `onComplete()` worker.

## `publish(event, data, options)`

Publish an event with optional data and options (Same as `send()` args). Looks up all subscriptions for the event and sends jobs to all those queues. Returns an array of job ids.

## `subscribe(event, name)`

Subscribe queue `name` to `event`.

## `unsubscribe(event, name)`

Remove the subscription of queue `name` to `event`.

## Scheduling

Jobs may be sent automatically based on a cron expression. As with other cron-based systems, at least one instance needs to be running for scheduling to work. In order to reduce the amount of evaluations, schedules are checked every 30 seconds, which means the 6-placeholder format should be discouraged in favor of the minute-level precision 5-placeholder format.

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
  noScheduling: true
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

## `cancel(id, options)`

Cancels a pending or active job.

The promise will resolve on a successful cancel, or reject if the job could not be cancelled.

## `cancel([ids], options)`

Cancels a set of pending or active jobs.

The promise will resolve on a successful cancel, or reject if not all of the requested jobs could not be cancelled.

> Due to the nature of the use case of attempting a batch job cancellation, it may be likely that some jobs were in flight and even completed during the cancellation request. Because of this, cancellation will cancel as many as possible and reject with a message showing the number of jobs that could not be cancelled because they were no longer active.

## `resume(id, options)`

Resumes a cancelled job.

## `resume([ids], options)`

Resumes a set of cancelled jobs.

## `complete(id [, data, options])`

Completes an active job.  This would likely only be used with `fetch()`. Accepts an optional `data` argument for usage with [`onComplete()`](#oncompletename--options-handler) state-based workers or `fetchCompleted()`.

The promise will resolve on a successful completion, or reject if the job could not be completed.

## `complete([ids], options)`

Completes a set of active jobs.

The promise will resolve on a successful completion, or reject if not all of the requested jobs could not be marked as completed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.

## `fail(id [, data, options])`

Marks an active job as failed.  This would likely only be used with `fetch()`. Accepts an optional `data` argument for usage with [`onFail()`](#onfailname--options-handler) state-based workers or `fetchFailed()`.

The promise will resolve on a successful assignment of failure, or reject if the job could not be marked as failed.

## `fail([ids], options)`

Fails a set of active jobs.

The promise will resolve on a successful failure state assignment, or reject if not all of the requested jobs could not be marked as failed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.

## `notifyWorker(id)`

Notifies a worker by id to bypass the job polling interval (see `newJobCheckInterval`) for this iteration in the loop.

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

## `getJobById(id, options)`

Retrieves a job with all metadata by id in either the primary or archive storage.

## `deleteQueue(name)`

Deletes all pending jobs in the specified queue from the active job table.  All jobs in the archive table are retained.

## `deleteAllQueues()`

Deletes all pending jobs from all queues in the active job table. All jobs in the archive table are retained.

## `clearStorage()`

Utility function if and when needed to empty all job storage. Internally, this issues a `TRUNCATE` command against all jobs tables, archive included.
