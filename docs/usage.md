# Usage <!-- omit in toc -->

<!-- TOC -->

- [Intro](#intro)
- [Database install](#database-install)
- [Database uninstall](#database-uninstall)
- [Direct database interactions](#direct-database-interactions)
  - [Job table](#job-table)
- [Events](#events)
  - [`error`](#error)
  - [`archived`](#archived)
  - [`expired`](#expired)
  - [`monitor-states`](#monitor-states)
- [Static functions](#static-functions)
  - [`string getConstructionPlans(schema)`](#string-getconstructionplansschema)
  - [`string getMigrationPlans(schema, version)`](#string-getmigrationplansschema-version)
  - [`string getRollbackPlans(schema, version)`](#string-getrollbackplansschema-version)
- [Functions](#functions)
  - [`new(connectionString)`](#newconnectionstring)
  - [`new(options)`](#newoptions)
  - [`start()`](#start)
  - [`stop()`](#stop)
  - [`connect()`](#connect)
  - [`disconnect()`](#disconnect)
  - [`publish()`](#publish)
    - [`publish(name, data, options)`](#publishname-data-options)
    - [`publish(request)`](#publishrequest)
    - [`publishAfter(name, data, options, seconds | ISO date string | Date)`](#publishaftername-data-options-seconds--iso-date-string--date)
    - [`publishOnce(name, data, options, key)`](#publishoncename-data-options-key)
    - [`publishThrottled(name, data, options, seconds [, key])`](#publishthrottledname-data-options-seconds--key)
    - [`publishDebounced(name, data, options, seconds [, key])`](#publishdebouncedname-data-options-seconds--key)
  - [`subscribe()`](#subscribe)
    - [`subscribe(name [, options], handler)`](#subscribename--options-handler)
    - [`onComplete(name [, options], handler)`](#oncompletename--options-handler)
  - [`unsubscribe(name)`](#unsubscribename)
    - [`offComplete(name)`](#offcompletename)
  - [`fetch()`](#fetch)
    - [`fetch(name)`](#fetchname)
    - [`fetch(name, batchSize)`](#fetchname-batchsize)
    - [`fetchCompleted(name [, batchSize])`](#fetchcompletedname--batchsize)
  - [`cancel(id)`](#cancelid)
  - [`cancel([ids])`](#cancelids)
  - [`complete(id [, data])`](#completeid--data)
  - [`complete([ids])`](#completeids)
  - [`fail(id [, data])`](#failid--data)
  - [`fail([ids])`](#failids)
  - [`deleteQueue(name)`](#deletequeuename)
  - [`deleteAllQueues()`](#deleteallqueues)
  - [`getQueueSize(name [, options])`](#getqueuesizename--options)
  - [`clearStorage()`](#clearstorage)

<!-- /TOC -->

# Intro
pg-boss is used by creating an instance of the exported class, a subclass of a Node [EventEmitter](https://nodejs.org/api/events.html). Since the majority of all interactions with pg-boss involve a database, all instance functions return promises. Once you have created an instance, nothing happens until you call either `start()` or `connect()`. When a job is created it is immediately persisted to the database, assigned to a queue by name and can be received from any pg-boss instance.

You may use as many instances in as many environments as needed based on your requirements.  Since each instance has a connection pool (or even if you bring your own), the only primary limitation on instance count is based on the maximum number of connections your database can accept.  If you need a larger number of workers than your postgres database can accept, consider using a centralized connection pool such as pgBouncer. If you have constraints preventing direct database access, consider creating your own abstraction layer over pg-boss such as a secure web API using the `fetch()` and `complete()` functions.  If you require multiple installations in the same database, you will need to specify a separate schema name per install in the constructor.

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

# Database uninstall

If you need to uninstall pg-boss from a database, just run the following command.

```sql
DROP SCHEMA $1 CASCADE
```

Where `$1` is the name of your schema if you've customized it.  Otherwise, the default schema is `pgboss`.

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
      keepUntil timestamp with time zone NOT NULL default now() + interval '30 days'
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

Ideally, code similar to the following example would be used after creating your instance, but  before `start()` or `connect()` is called.

```js
boss.on('error', error => logger.error(error));
```

> **Note: Since error events are only raised during internal housekeeping activities, they are not raised for direct API calls, where promise `catch()` handlers should be used.**


## `archived`

`archived` is raised each time 1 or more jobs are archived.  The payload is an integer representing the number of jobs archived.

## `expired`

`expired` is raised each time 1 or more jobs are expired.  The payload is an integer representing the number of jobs expired.

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
  archiveIntervalDays: 2
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

Since it is responsible for both schema migrations and monitoring jobs for expiration and archiving, at least 1 instances of `start()` should be used per database. If your deployment requires additional instances for job processing, you may use either `start()` or `connect()`. If the required database objects do not exist in the specified database, **`start()` will automatically create them**. The same process is true for updates as well. If a new schema version is required, pg-boss will automatically migrate the internal storage to the latest installed version.

> While this is most likely a welcome feature, be aware of this during upgrades since this could delay the promise resolution by however long the migration script takes to run against your data.  For example, if you happened to have millions of jobs in the job table just hanging around for archiving and the next version of the schema had a couple of new indexes, it may take a few seconds before `start()` resolves. Most migrations are very quick, however, and are designed with performance in mind.

Additionally, all schema operations, both first-time provisioning and migrations, are nested within advisory locks to prevent race conditions during `start()`. Internally, these locks are created using `pg_advisory_xact_lock()` which auto-unlock at the end of the transaction and don't require a persistent session or the need to issue an unlock. This should make it compatible with most connection poolers, such as pgBouncer in transactional pooling mode.

One example of how this is useful would be including `start()` inside the bootstrapping of a pod in a ReplicaSet in Kubernetes. Being able to scale up your job processing using a container orchestration tool like k8s is becoming more and more popular, and pg-boss can be dropped into this system with no additional logic, fear, or special configuration.

## `stop()`

**returns: Promise**

All job monitoring will be stopped and all subscriptions on this instance will be removed. Basically, it's the opposite of `start()`. Even though `start()` may create new database objects during initialization, `stop()` will never remove anything from the database.

## `connect()`

**returns: Promise** *(resolves the same PgBoss instance used during invocation for convenience)*

Connects to an existing job database, but does not run any maintenance or monitoring operations.

This may be used for secondary workers running in other processes or servers, with the assumption that `start()` was previously used against this database instance.

## `disconnect()`

**returns: Promise**

The opposite of `connect()`.  Disconnects from a job database. All subscriptions on this instance will be removed.

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

Publish a job with a unique key to make sure it isn't processed more than once.  Any other jobs published during this archive interval with the same queue name and key will be rejected.

This is a convenience version of `publish()` with the `singletonKey` option assigned.

### `publishThrottled(name, data, options, seconds [, key])`

Only allows one job to be published to the same queue within a number of seconds.  In this case, the first job within the interval is allowed, and all other jobs within the same interval are rejected.

This is a convenience version of `publish()` with the `singletonSeconds` and `singletonKey` option assigned. The `key` argument is optional.

### `publishDebounced(name, data, options, seconds [, key])`

Like, `publishThrottled()`, but instead of rejecting if a job is already published in the current interval, it will try to add the job to the next interval if one hasn't already been published.

This is a convenience version of `publish()` with the `singletonSeconds`, `singletonKey` and `singletonNextSlot` option assigned. The `key` argument is optional.

## `subscribe()`

**returns: Promise**

Polls the database by a queue name or a pattern and executes the provided callback function when jobs are found.  The promise resolves once a subscription has been created.

Queue patterns use the `*` character to match 0 or more characters.  For example, a job from queue `status-report-12345` would be fetched with pattern `status-report-*` or even `stat*5`.

The default concurrency for `subscribe()` is 1 job per second.  Both the interval and the number of jobs per interval can be customized by passing an optional [configuration option](configuration.md#subscribe-options) argument.

### `subscribe(name [, options], handler)`

**Arguments**
- `name`: string, *required*
- `options`: object
- `handler`: function(job), *required*

If your handler function returns a promise, pg-boss will defer polling for new jobs until it resolves. Meaning, you'll get backpressure for free! Even though it's not required to return a promise, it's encouraged in order to make your instance more robust and reliable under load. For example, if your database were to experience a high load, it may slow down what otherwise may be a quick operation.  Being able to defer polling and emitting more jobs will make sure you don't overload an already busy system and add to the existing load.

The job object has the following properties.

| Prop | Type | |
| - | - | -|
|`id`| string, uuid |
|`name`| string |
|`data`| object |
|`done(err, data)` | function | callback function used to mark the job as completed or failed in the database.

The job completion callback is not required if you return a promise from your handler. If you return a promise, the value you resolve will be provided in the completion job, and if your promise throws, pg-boss will catch it and mark the job as failed.

If you do not return a promise, `done()` should be used to mark the job as completed or failed (just like in 2.x below). In that case, `done()` accepts optional arguments, the first being an error in typical node fashion. The second argument is an optional `data` argument for usage with [`onComplete()`](#oncompletename--options-handler) state-based subscriptions. If an error is passed, it will mark the job as failed.

> If you forget to use a promise or the callback function to mark the job as completed, it will expire after the configured expiration period.  The default expiration can be found in the [configuration docs](configuration.md#job-expiration).

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

## `unsubscribe(name)`

Removes a subscription by name and stops polling.

### `offComplete(name)`

Same as `unsubscribe()`, but removes an `onComplete()` subscription.

## `fetch()`

Typically one would use `subscribe()` for automated polling for new jobs based upon a reasonable interval to finish the most jobs with the lowest latency. While `subscribe()` is a yet another free service we offer and it can be awfully convenient, sometimes you may have a special use case around when a job can be retrieved. Or, perhaps like me, you need to provide jobs via other entry points such as a web API.

`fetch()` allows you to skip all that polling nonsense that `subscribe()` does and puts you back in control of database traffic. Once you have your shiny job, you'll use either `complete()` or `fail()` to mark it as finished.

### `fetch(name)`

**Arguments**
- `name`: string, queue name or pattern

**Resolves**
- `job`: job object, `null` if none found

### `fetch(name, batchSize)`

**Arguments**
- `name`: string, queue name or pattern
- `batchSize`: number, # of jobs to fetch

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

### `fetchCompleted(name [, batchSize])`

Same as `fetch()`, but retrieves any completed jobs. See [`onComplete()`](#oncompletename--options-handler) for more information.

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

## `deleteQueue(name)`

Deletes all pending jobs in the specified queue from the active job table.  All jobs in the archive table are retained.

## `deleteAllQueues()`

Deletes all pending jobs from all queues in the active job table. All jobs in the archive table are retained.

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

## `clearStorage()`

Utility function if and when needed to empty all job storage. Internally, this issues a `TRUNCATE` command against all jobs tables, archive included.
