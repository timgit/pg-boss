Usage
=====

<!-- TOC -->

- [Usage](#usage)
- [Intro](#intro)
- [Instance functions](#instance-functions)
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
- [Events](#events)
  - [`error`](#error)
  - [`archived`](#archived)
  - [`expired`](#expired)
  - [`monitor-states`](#monitor-states)
- [Static functions](#static-functions)
  - [`string getConstructionPlans(schema)`](#string-getconstructionplansschema)
  - [`string getMigrationPlans(schema, version, uninstall)`](#string-getmigrationplansschema-version-uninstall)

<!-- /TOC -->

# Intro
pg-boss is used by creating an instance of the exported class, a subclass of a Node [EventEmitter](https://nodejs.org/api/events.html). Since the majority of all interactions with pg-boss involve a database, all instance functions return promises. Once you have created an instance, nothing happens until you call either `start()` or `connect()`. When a job is created it is immediately persisted to the database, assigned to a queue by name and can be received from any pg-boss instance. 

You may use as many instances in as many environments as needed based on your requirements.  Since each instance has a connection pool (or even if you bring your own), the only primary limitation on instance count is based on the maximum number of connections your database can accept.  If you need a larger number of workers than your postgres database can accept, or if you have constraints regarding direct database access, you should consider creating your own abstraction layer over pg-boss using the `fetch()` and `complete()` APIs.

# Instance functions

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
  poolSize: 5, // or max: 5
  archiveCompletedJobsEvery: '2 days'
};

let boss;

try {
  boss = new PgBoss(options);
}
catch(error) {
  console.error(error);
}
```

## `start()`

**returns: Promise** *(resolves the same PgBoss instance used during invocation for convenience)*

Prepares the target database and begins job monitoring.

```js
boss.start()
  .then(boss => {
    boss.publish('hey-there', {msg:'this came for you'});
  });
```

Since it is responsible for monitoring jobs for expiration and archiving, `start()` *should be called once and only once per backing database store.* Once this has been taken care of, if your use cases demand additional instances for job processing, you should use `connect()`.

> Keep calm, however, if you were to accidentally call `start()` from independently hosted instances pointing to the same database.  While it would be considered by most a bit wasteful to monitor jobs multiple times, no major harm will occur. :)

If the required database objects do not exist in the specified database, **`start()` will automatically create them**. In order for this step to be successful, the specified user account will need the [CREATE](http://www.postgresql.org/docs/9.5/static/sql-grant.html) privilege. For example, the following command grants this privilege.

```sql
GRANT CREATE ON DATABASE ReallyImportantDb TO mostvaluableperson;
```

But wait. There's more! `start()` also verifies the versions of the objects and will **automatically migrate your job system to the latest installed version** of pg-boss.  

> While this is most likely a welcome feature, be aware of this during upgrades since this could delay the promise resolution by however long the migration script takes to run against your data.  For example, if you happened to have millions of jobs in the job table just hanging around for archiving and the next version of the schema had a couple of new indexes, it may take a handful of seconds before `start()` resolves.

If the CREATE privilege is not granted (so sad), you can still use the static function `PgBoss.getConstructionPlans()` method to export the SQL required to manually create the objects.  This means you will also need to monitor future releases for schema changes (the schema property in [version.json](../version.json)) so they can be applied manually. In which case you'll be interested in `PgBoss.getMigrationPlans()` for manual migration scripts.

## `stop()`

**returns: Promise**

All job monitoring will be stopped and all subscriptions on this instance will be removed. Basically, it's the opposite of `start()`. Even though `start()` may create new database objects during initialization, `stop()` will never remove anything from the database.  

**If you need to uninstall pg-boss from a database, just run the following command.** 

```sql
DROP SCHEMA $1 CASCADE
```

Where `$1` is the name of your schema if you've customized it.  Otherwise, the default schema is `pgboss`.

## `connect()`

**returns: Promise** *(resolves the same PgBoss instance used during invocation for convenience)*

Connects to an existing job database.

`connect()` is used for secondary workers running in other processes or servers, with the assumption that `start()` was previously used against this database instance. `connect()` doesn't start job expiration monitoring or archiving intervals like `start()`.

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
var payload = {
    email: "billybob@veganplumbing.com",
    name: "Billy Bob"
};

var options =   {
    startAfter: 1,
    retryLimit: 2
};

boss.publish('email-send-welcome', payload, options)
  .then(jobId => console.log(`job ${jobId} submitted`));
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
boss.publish({
  name: 'database-backup',
  options: { retryLimit: 1 }
})
.then(id => console.log(`job ${id} submitted`));
```

### `publishAfter(name, data, options, seconds | ISO date string | Date)`

Publish a job that should start after a number of seconds from now, or after a specific date time.  

This is a convenience verion of `publish()` with the `startAfter` option assigned.

### `publishOnce(name, data, options, key)`

Publish a job with a unique key to make sure it isn't processed more than once.  Any other jobs published during this archive interval with the same queue name and key will be rejected. 

This is a convenience verion of `publish()` with the `singletonKey` option assigned.

### `publishThrottled(name, data, options, seconds [, key])`

Only allows one job to be published to the same queue within a number of seconds.  In this case, the first job within the interval is allowed, and all other jobs within the same interval are rejected.

This is a convenience verion of `publish()` with the `singletonSeconds` and `singletonKey` option assigned. The `key` argument is optional.

### `publishDebounced(name, data, options, seconds [, key])`

Like, `publishThrottled()`, but instead of rejecting if a job is already published in the current interval, it will try to add the job to the next interval is one hasn't already been published. 

This is a convenience verion of `publish()` with the `singletonSeconds`, `singletonKey` and `singletonNextSlot` option assigned. The `key` argument is optional.

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

Following is an example of a subscription that returns a promise for completion with the teamSize option set for increased job concurrency between polling intervals.

```js
boss.subscribe('email-welcome', {teamSize: 5, teamConcurrency: 5}, 
      job => myEmailService.sendWelcomeEmail(job.data))
  .then(() => console.log('subscription created'))
  .catch(error => console.error(error));
```

And the same example, but without returning a promise in the handler.

```js
boss.subscribe('email-welcome', {teamSize: 5, teamConcurrency: 5}, 
      job => {
        myEmailService.sendWelcomeEmail(job.data)
          .then(() => job.done())
          .catch(error => job.done(error));
  })
  .then(() => console.log('subscription created'))
  .catch(error => console.error(error));
```

Similar to the first example, but with a batch of jobs at once.

```js
boss.subscribe('email-welcome', {batchSize: 5}, 
      jobs => myEmailService.sendWelcomeEmails(jobs.map(job => job.data))
  )
  .then(() => console.log('subscription created'))
  .catch(error => console.error(error));
```

### `onComplete(name [, options], handler)`

Sometimes when a job completes, expires or fails, it's important enough to trigger other things that should react to it. `onComplete` works identically to `subscribe()` and was created to facilitate the creation of orchestrations or sagas between jobs that may or may not know about each other. This common messaging pattern allows you to keep multi-job flow logic out of the individual job handlers so you can manage things in a more centralized fashion while not losing your mind. As you most likely already know, asynchronous jobs are complicated enough already.

> Internally, these jobs have a special prefix of `__state__completed__`.  Since pg-boss creates these and it's possible that no subscriptions will ever be created for retrieving them, they are considered "second class" and will be archived even if they remain in 'created' state. Keep this in mind if you customize your archive interval.

The callback for `onComplete()` returns a job containing the original job and completion details. `request` will be the original job as submitted with `id`, `name` and `data`. `response` may or may not have a value based on arguments in [complete()](#completeid--data) or [fail()](#failid--data).

Here's an example from the test suite showing this in action.

```js
 it('onComplete should have both request and response', function(finished){

    const jobName = 'onCompleteFtw';
    const requestPayload = {token:'trivial'};
    const responsePayload = {message: 'so verbose', code: '1234'};

    let jobId = null;

    boss.onComplete(jobName, job => {
      assert.equal(jobId, job.data.request.id);
      assert.equal(job.data.request.data.token, requestPayload.token);
      assert.equal(job.data.response.message, responsePayload.message);
      assert.equal(job.data.response.code, responsePayload.code);

      finished();
    });

    boss.publish(jobName, requestPayload)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(job => boss.complete(job.id, responsePayload));

  });
```

And here's an example job from the callback in this test.


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

Note: If you pass a batchSize, `fetch()` will always resovle an array response, even if only 1 job is returned. This seemed like a great idea at the time.

The following code shows how to utilize batching via `fetch()` to get and complete 20 jobs at once on-demand.

```js
const jobName = 'email-daily-digest';
const batchSize = 20;

boss.fetch(jobName, batchSize)
  .then(jobs => {
    if(!jobs) return;

    console.log(`received ${jobs.length} ${jobName} jobs`);

    // our magical emailer knows what to do with job.data
    let promises = jobs.map(job => emailer.send(job.data).then(() => boss.complete(job.id)));
    
    return Promise.all(promises);      
  })
  .catch(error => console.log(error));
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

The `monitor-states` event is conditionally raised based on the `monitorStateInterval` configuration setting.  If passed during instance creation, it will provide a count of jobs in each state per interval.  This could be useful for logging or even determining if the job system is handling its load.

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

## `string getMigrationPlans(schema, version, uninstall)`

**Arguments**
- `schema`: string, database schema name
- `version`: string, target schema version to migrate
- `uninstall`: boolean, reverts to the previous version if true

Returns the SQL commands required to manually migrate to or from the specified version.
