# Usage <!-- omit in toc -->

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
  - [`stop()`](#stop)
  - [`publish()`](#publish)
    - [`publish(name, data, options)`](#publishname-data-options)
    - [`publish(request)`](#publishrequest)
    - [`publishAfter(name, data, options, seconds | ISO date string | Date)`](#publishaftername-data-options-seconds--iso-date-string--date)
    - [`publishOnce(name, data, options, key)`](#publishoncename-data-options-key)
    - [`publishSingleton(name, data, options)`](#publishsingletonname-data-options)
    - [`publishThrottled(name, data, options, seconds [, key])`](#publishthrottledname-data-options-seconds--key)
    - [`publishDebounced(name, data, options, seconds [, key])`](#publishdebouncedname-data-options-seconds--key)
  - [`subscribe()`](#subscribe)
    - [`subscribe(name [, options], handler)`](#subscribename--options-handler)
    - [`onComplete(name [, options], handler)`](#oncompletename--options-handler)
  - [`unsubscribe(value)`](#unsubscribevalue)
    - [`offComplete(value)`](#offcompletevalue)
  - [`fetch()`](#fetch)
    - [`fetch(name)`](#fetchname)
    - [`fetch(name, batchSize, [, options])`](#fetchname-batchsize--options)
    - [`fetchCompleted(name [, batchSize] [, options])`](#fetchcompletedname--batchsize--options)
  - [Scheduling](#scheduling)
    - [`schedule(name, cron, data, options)`](#schedulename-cron-data-options)
    - [`unschedule(name)`](#unschedulename)
    - [`getSchedules()`](#getschedules)
  - [`cancel(id)`](#cancelid)
  - [`cancel([ids])`](#cancelids)
  - [`complete(id [, data])`](#completeid--data)
  - [`complete([ids])`](#completeids)
  - [`fail(id [, data])`](#failid--data)
  - [`fail([ids])`](#failids)
  - [`getQueueSize(name [, options])`](#getqueuesizename--options)
  - [`getJobById(id)`](#getjobbyidid)
  - [`deleteQueue(name)`](#deletequeuename)
  - [`deleteAllQueues()`](#deleteallqueues)
  - [`clearStorage()`](#clearstorage)

<!-- /TOC -->

# Intro
pg-boss is a job queue written in Node.js and backed by the reliability of Postgres.

You may use as many instances as needed to connect to the same Postgres database.  Each instance maintains a connection pool (or you bring your own), so the only limitation on connection count is based on the maximum number of connections your database can accept.  If you need a larger number of workers than your postgres database can accept, consider using a centralized connection pool such as pgBouncer. If you have constraints preventing direct database access, consider creating your own abstraction layer over pg-boss such as a secure web API using the `fetch()` and `complete()` functions.  

If you require multiple installations in the same database, such as for large volume queues, you may wish to specify a separate schemas per install to achieve partitioning.

## Job states

A pg-boss job undergoes certain states during its lifetime. All jobs start out as `created` - from there, they will usually become `active` when picked up for work. If job processing completes successfully, jobs will go to `completed`. If job processing is not successful, jobs will go to either `failed` or `retry` (if they were started with the respective retry options). It's also possible for `active` jobs to become `expired`, which happens when job processing takes too long.

Jobs can also be `cancelled` via [`cancel(id)`](#cancelid) or [`cancel([ids])`](#cancelids), which will transition them into the `cancelled` state.

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
DROP TABLE ${schema}.version;
DROP TYPE ${schema}.job_state;
```

# Direct database interactions

If you need to interact with pg-boss outside of Node.js, such as other clients or even using triggers within PostgreSQL itself, most functionality is supported even when working directly against the internal tables.  Additionally, you may even decide to do this within Node.js. For example, if you wanted to bulk load jobs into pg-boss and skip calling `publish()` one job at a time, you could either use `INSERT` or the faster `COPY` command.

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

As explained in the introduction above, each instance of pg-boss is an EventEmitter.  You can run multiple instances of pg-boss for a variety of use cases including distribution and load balancing. Each instance has the freedom to subscribe to whichever jobs you need.  Because of this diversity, the job activity of one instance could be drastically different from another.  Therefore, **all of the events raised by pg-boss are instance-bound.**

> For example, if you were to subscribe to `error` in instance A, it will not receive an `error` event from instance B.

## `error`
The error event is raised from any errors that may occur during internal job fetching, monitoring and archiving activities. While not required, adding a listener to the error event is strongly encouraged:

> If an EventEmitter does not have at least one listener registered for the 'error' event, and an 'error' event is emitted, the error is thrown, a stack trace is printed, and the Node.js process exits.
>
>Source: [Node.js Events > Error Events](https://nodejs.org/api/events.html#events_error_events)

Ideally, code similar to the following example would be used after creating your instance, but before `start()` is called.

```js
boss.on('error', error => logger.error(error));
```

> **Note: Since error events are only raised during internal housekeeping activities, they are not raised for direct API calls, where promise `catch()` handlers should be used.**

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

Emitted at most once every 2 seconds when polling subscriptions are active and jobs are entering or leaving active state. The payload is an array that represents each worker in this instance of pg-boss.  If you want to monitor queue activity across all instances, use `monitor-states`.

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

Emitted after `stop()` once all subscription workers have completed their work and maintenance has been shut down.

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
const boss = new PgBoss('postgres://user:pass@host/database');
```

## `new(options)`

Passing an object argument supports [advanced initialization options](configuration.md#constructor-options).

```js
const options = {
  host: 'host',
  database: 'database',
  user: 'user',
  password: 'password',
  max: 5,
  retentionDays: 7
};

const boss = new PgBoss(options);
```

## `start()`

**returns: Promise** *(resolves the same PgBoss instance used during invocation for convenience)*

Prepares the target database and begins job monitoring.

```js
await boss.start()
await boss.publish('hey-there', { msg:'this came for you' })
```

If the required database objects do not exist in the specified database, **`start()` will automatically create them**. The same process is true for updates as well. If a new schema version is required, pg-boss will automatically migrate the internal storage to the latest installed version.

> While this is most likely a welcome feature, be aware of this during upgrades since this could delay the promise resolution by however long the migration script takes to run against your data.  For example, if you happened to have millions of jobs in the job table just hanging around for archiving and the next version of the schema had a couple of new indexes, it may take a few seconds before `start()` resolves. Most migrations are very quick, however, and are designed with performance in mind.

Additionally, all schema operations, both first-time provisioning and migrations, are nested within advisory locks to prevent race conditions during `start()`. Internally, these locks are created using `pg_advisory_xact_lock()` which auto-unlock at the end of the transaction and don't require a persistent session or the need to issue an unlock. This should make it compatible with most connection poolers, such as pgBouncer in transactional pooling mode.

One example of how this is useful would be including `start()` inside the bootstrapping of a pod in a ReplicaSet in Kubernetes. Being able to scale up your job processing using a container orchestration tool like k8s is becoming more and more popular, and pg-boss can be dropped into this system with no additional logic, fear, or special configuration.

## `stop()`

**returns: Promise**

All job monitoring will be stopped and all subscriptions on this instance will be removed. Basically, it's the opposite of `start()`. Even though `start()` may create new database objects during initialization, `stop()` will never remove anything from the database.

## `publish()`

**returns: Promise**

Creates a new job and resolves the job's unique identifier (uuid).

> `publish()` will resolve a `null` for job id under some use cases when using [unique jobs](configuration.md#unique-jobs) or [throttling](configuration.md#throttled-jobs).  These options are always opt-in on the publish side and therefore don't result in a promise rejection.

### `publish(name, data, options)`

**Arguments**

- `name`: string, *required*
- `data`: object
- `options`: object ([publish options](configuration.md#publish-options))

```js
const payload = {
    email: "billybob@veganplumbing.com",
    name: "Billy Bob"
};

const options =   {
    startAfter: 1,
    retryLimit: 2
};

const jobId = await boss.publish('email-send-welcome', payload, options)
console.log(`job ${jobId} submitted`)
```

### `publish(request)`

**Arguments**

- `request`: object

The request object has the following properties.

| Prop | Type | |
| - | - | -|
|`name`| string | *required*
|`data`| object |
|`options` | object | [publish options](configuration.md#publish-options)


This overload is for conditionally including data or options based on keys in an object, such as the following.

```js
const jobId = await boss.publish({
    name: 'database-backup',
    options: { retryLimit: 1 }
})

console.log(`job ${jobId} submitted`)
```

### `publishAfter(name, data, options, seconds | ISO date string | Date)`

Publish a job that should start after a number of seconds from now, or after a specific date time.

This is a convenience version of `publish()` with the `startAfter` option assigned.

### `publishOnce(name, data, options, key)`

Publish a job with a unique key to only allow 1 job to be in created, retry, or active state at a time.

This is a convenience version of `publish()` with the `singletonKey` option assigned.

### `publishSingleton(name, data, options)`

Publish a job but only allow 1 job to be in created or retry state at at time.

This is a convenience version of `publish()` with the `singletonKey` option assigned.

### `publishThrottled(name, data, options, seconds [, key])`

Only allows one job to be published to the same queue within a number of seconds.  In this case, the first job within the interval is allowed, and all other jobs within the same interval are rejected.

This is a convenience version of `publish()` with the `singletonSeconds` and `singletonKey` option assigned. The `key` argument is optional.

### `publishDebounced(name, data, options, seconds [, key])`

Like, `publishThrottled()`, but instead of rejecting if a job is already published in the current interval, it will try to add the job to the next interval if one hasn't already been published.

This is a convenience version of `publish()` with the `singletonSeconds`, `singletonKey` and `singletonNextSlot` option assigned. The `key` argument is optional.

## `subscribe()`

**returns: Promise**

Polls the database by a queue name or a pattern and executes the provided callback function when jobs are found.  The promise resolves once a subscription has been created with a unique id of the subscription.  You can monitor the state of subscriptions using the `wip` event.

Queue patterns use the `*` character to match 0 or more characters.  For example, a job from queue `status-report-12345` would be fetched with pattern `status-report-*` or even `stat*5`.

The default concurrency for `subscribe()` is 1 job every 2 seconds. Both the interval and the number of jobs per interval can be changed globally or per-queue with [configuration options](configuration.md#subscribe-options).

### `subscribe(name [, options], handler)`

**Arguments**
- `name`: string, *required*
- `options`: object
- `handler`: function(job), *required*

Typically `handler` should be an `async` function unless you have a good reason not to, since this automatically returns promises that can be handled efficiently. 

If handler returns a promise, the value resolved/returned will be stored in a completion job. Likewise, if an error occurs in the handler, it will be caught and useful error properties stored into a completion job in addition to marking the job as failed.

Finally, and importantly, promise-returning handlers will be awaited before polling for new jobs which provides **automatic backpressure**.

The job object has the following properties.

| Prop | Type | |
| - | - | -|
|`id`| string, uuid |
|`name`| string |
|`data`| object |
|`done(err, data)` | function | callback function used to mark the job as completed or failed. Returns a promise.

If `handler` does not return a promise, `done()` should be used to mark the job as completed or failed. `done()` accepts optional arguments, `err` and `data`, for usage with [`onComplete()`](#oncompletename--options-handler) state-based subscriptions. If `err` is truthy, it will mark the job as failed.

> If the job is not completed, either by returning a promise from `handler` or manually via `job.done()`, it will expire after the configured expiration period.  The default expiration can be found in the [configuration docs](configuration.md#job-expiration).

Following is an example of a subscription that returns a promise (`sendWelcomeEmail()`) for completion with the teamSize option set for increased job concurrency between polling intervals.

```js
const options = { teamSize: 5, teamConcurrency: 5 }
await boss.subscribe('email-welcome', options, job => myEmailService.sendWelcomeEmail(job.data))
```

And the same example, but without returning a promise in the handler.

```js
const options = { teamSize: 5, teamConcurrency: 5 }
await boss.subscribe('email-welcome', options, job => {
    myEmailService.sendWelcomeEmail(job.data)
        .then(() => job.done())
        .catch(error => job.done(error))
  })
```

Similar to the first example, but with a batch of jobs at once.

```js
await boss.subscribe('email-welcome', { batchSize: 5 },
    jobs => myEmailService.sendWelcomeEmails(jobs.map(job => job.data))
)
```

### `onComplete(name [, options], handler)`

Sometimes when a job completes, expires or fails, it's important enough to trigger other things that should react to it. `onComplete` works identically to `subscribe()` and was created to facilitate the creation of orchestrations or sagas between jobs that may or may not know about each other. This common messaging pattern allows you to keep multi-job flow logic out of the individual job handlers so you can manage things in a more centralized fashion while not losing your mind. As you most likely already know, asynchronous jobs are complicated enough already. Internally, these jobs have a special prefix of `__state__completed__`.

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

const jobId = await boss.publish(jobName, requestPayload)
const job = await boss.fetch(jobName)
await boss.complete(job.id, responsePayload)
```

The following is an example data object from the job retrieved in the onComplete() subscription above.

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

## `unsubscribe(value)`

Removes a subscription by name or id and stops polling.

** Arguments **
- value: string or object

  If a string, removes all subscriptions found matching the name.  If an object, only the subscription with a matching `id` will be removed.

### `offComplete(value)`

Similar to `unsubscribe()`, but removes an `onComplete()` subscription.

** 

## `fetch()`

Typically one would use `subscribe()` for automated polling for new jobs based upon a reasonable interval to finish the most jobs with the lowest latency. While `subscribe()` is a yet another free service we offer and it can be awfully convenient, sometimes you may have a special use case around when a job can be retrieved. Or, perhaps like me, you need to provide jobs via other entry points such as a web API.

`fetch()` allows you to skip all that polling nonsense that `subscribe()` does and puts you back in control of database traffic. Once you have your shiny job, you'll use either `complete()` or `fail()` to mark it as finished.

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

**Resolves**
- `[job]`: array of job objects, `null` if none found

Note: If you pass a batchSize, `fetch()` will always resolve an array response, even if only 1 job is returned. This seemed like a great idea at the time.

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

## Scheduling

Jobs may be published automatically based on a cron expression. As with other cron-based systems, at least one instance needs to be running for scheduling to work. In order to reduce the amount of evaluations, schedules are checked every 30 seconds, which means the 6-placeholder format should be discouraged in favor of the minute-level precision 5-placeholder format. 

For example, use this format, which implies "any second during 3:30 am every day"

```
30 3 * * *
```

but **not** this format which is parsed as "only run exactly at 3:30:30 am every day"

```
30 30 3 * * *
```

In order mitigate clock skew and drift, every 10 minutes the clocks of each instance are compared to the database server's clock. The skew, if any, is stored and used as an offset during cron evaluation to ensure all instances are synchronized. Internally, job throttling options are then used to make sure only 1 job is published even if multiple instances are running. 

If needed, the default clock monitoring interval can be adjusted using `clockMonitoringIntervalSeconds` or `clockMonitoringIntervalMinutes`. Additionally, to disable scheduling on an instance completely, use the following in the constructor options.

```js
{
  noScheduling: true
}
```

For more cron documentation and examples see the docs for the [cron-parser package](https://www.npmjs.com/package/cron-parser).

### `schedule(name, cron, data, options)`

Schedules a job to be published to the specified queue based on a cron expression. If the schedule already exists, it's updated to the new cron expression. 

**Arguments**

- `name`: string, *required*
- `cron`: string, *required*
- `data`: object
- `options`: object

`options` supports all properties in [publish options](configuration.md#publish-options) and an optional `tz` property that specifies a time zone name. If not specified, the default is UTC.

For example, the following code will publish a job at 3:00am in the US central time zone into the queue `notification-abc`.

```js
await boss.schedule('notification-abc', `0 3 * * *`, null, { tz: 'America/Chicago' })
```

### `unschedule(name)`

Removes a schedule by queue name.

### `getSchedules()`

Retrieves an array of all scheduled jobs currently being monitored.

## `cancel(id)`

Cancels a pending or active job.

The promise will resolve on a successful cancel, or reject if the job could not be cancelled.

## `cancel([ids])`

Cancels a set of pending or active jobs.

The promise will resolve on a successful cancel, or reject if not all of the requested jobs could not be cancelled.

> Due to the nature of the use case of attempting a batch job cancellation, it may be likely that some jobs were in flight and even completed during the cancellation request. Because of this, cancellation will cancel as many as possible and reject with a message showing the number of jobs that could not be cancelled because they were no longer active.

## `complete(id [, data])`

Completes an active job.  This would likely only be used with `fetch()`. Accepts an optional `data` argument for usage with [`onComplete()`](#oncompletename--options-handler) state-based subscriptions or `fetchCompleted()`.

The promise will resolve on a successful completion, or reject if the job could not be completed.

## `complete([ids])`

Completes a set of active jobs.

The promise will resolve on a successful completion, or reject if not all of the requested jobs could not be marked as completed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.

## `fail(id [, data])`

Marks an active job as failed.  This would likely only be used with `fetch()`. Accepts an optional `data` argument for usage with [`onFail()`](#onfailname--options-handler) state-based subscriptions or `fetchFailed()`.

The promise will resolve on a successful assignment of failure, or reject if the job could not be marked as failed.

## `fail([ids])`

Fails a set of active jobs.

The promise will resolve on a successful failure state assignment, or reject if not all of the requested jobs could not be marked as failed.

> See comments above on `cancel([ids])` regarding when the promise will resolve or reject because of a batch operation.

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

## `getJobById(id)`

Retrieves a job with all metadata by id in either the primary or archive storage.

## `deleteQueue(name)`

Deletes all pending jobs in the specified queue from the active job table.  All jobs in the archive table are retained.

## `deleteAllQueues()`

Deletes all pending jobs from all queues in the active job table. All jobs in the archive table are retained.

## `clearStorage()`

Utility function if and when needed to empty all job storage. Internally, this issues a `TRUNCATE` command against all jobs tables, archive included.
