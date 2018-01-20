Usage
=====

<!-- TOC -->

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
    - [`subscribe()`](#subscribe)
        - [`subscribe(name [, options], handler)`](#subscribename--options-handler)
    - [State-based subscriptions](#state-based-subscriptions)
        - [`onComplete(name [, options], handler)`](#oncompletename--options-handler)
        - [`onExpire(name [, options], handler)`](#onexpirename--options-handler)
        - [`onFail(name [, options], handler)`](#onfailname--options-handler)
    - [`unsubscribe(name)`](#unsubscribename)
        - [`offComplete(name)`](#offcompletename)
        - [`offExpire(name)`](#offexpirename)
        - [`offFail(name)`](#offfailname)
    - [`fetch()`](#fetch)
        - [`fetch(name)`](#fetchname)
        - [`fetch(name, batchSize)`](#fetchname-batchsize)
        - [`fetchCompleted(name [, batchSize])`](#fetchcompletedname--batchsize)
        - [`fetchExpired(name [, batchSize])`](#fetchexpiredname--batchsize)
        - [`fetchFailed(name [, batchSize])`](#fetchfailedname--batchsize)
    - [`cancel(id)`](#cancelid)
    - [`cancel([ids])`](#cancelids)
    - [`complete(id [, data])`](#completeid--data)
    - [`complete([ids])`](#completeids)
    - [`fail(id [, data])`](#failid--data)
    - [`fail([ids])`](#failids)
- [Events](#events)
    - [`error`](#error)
    - [`job`](#job)
    - [`failed`](#failed)
    - [`archived`](#archived)
    - [`expired-count`](#expired-count)
    - [`expired-job`](#expired-job)
    - [`monitor-states`](#monitor-states)
- [Static functions](#static-functions)
    - [`string getConstructionPlans(schema)`](#string-getconstructionplansschema)
    - [`string getMigrationPlans(schema, version, uninstall)`](#string-getmigrationplansschema-version-uninstall)

<!-- /TOC -->

# Instance functions

pg-boss is used by instantiating an instance of the exported class, which is actually a subclass of a Node [EventEmitter](https://nodejs.org/api/events.html). Any errors encountered during construction are thrown, so try catch is encouraged here. Since the majority of all interactions with pg-boss involve the database, all instance functions return promises, where `catch()` is encouraged. Once you have created an instance, nothing happens until you call either `start()` or `connect()`. In the case of `start()`, pg-boss begins monitoring the job system. If any errors occur during these operations, `error` will be emitted.

All jobs created are immediately added to the database and can be received from any pg-boss instance with access to the database. There is no limit to the number of independent instances that can connect to a database. Each instance can create jobs, subscribe to receive jobs asynchronously, or manually fetch and interact with jobs. Jobs are always stored and managed by name. Each job name represents a queue for that job which is processed by creation order (FIFO) or by an optional priority.

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
  poolSize: 5,
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
    startIn: "1 minute",
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

## `subscribe()`

**returns: Promise**

Polls the database for a job by name and executes the provided callback function when found.  The promise resolves once a subscription has been created.  

The default concurrency for `subscribe()` is 1 job per second.  Both the interval and the number of jobs per interval can be customized by passing an optional [configuration option](configuration.md#subscribe-options) argument.

### `subscribe(name [, options], handler)`

**Arguments**
- `name`: string, *required*
- `options`: object
- `handler`: function(job, callback)

When you provide the `handler` callback, it should have at least 1 argument for the job. The second argument is a convenience 'done' callback that will finish the job before it expires. The job object also has this callback attached as `done()` for convenience.

The job object has the following properties.

| Prop | Type | |
| - | - | -|
|`id`| string, uuid |
|`name`| string |
|`data`| object | data sent from `publish()`
|`done(err, data)` | function | callback function used to mark the job as completed or failed in the database.

`done()` accepts optional arguments, the first being an error in typical node fashion. The second argument is an optional `data` argument for usage with [`onComplete()`](#oncompletename--options-handler) state-based subscriptions. If an error is passed, it will mark the job as failed and the data argument will be ignored.

> If you forget to use the callback function to mark the job as completed, it will expire after the configured expiration period.  The default expiration can be found in the [configuration docs](configuration.md#job-expiration).

Following is an example of a subscription with the teamSize option set for increased job concurrency between polling intervals.

```js
boss.subscribe('email-welcome', {teamSize: 5}, job => {
    myEmailService.sendWelcomeEmail(job.data)
      .then(() => job.done())
      .catch(error => job.done(error));
  })
  .then(() => console.log('subscription created'))
  .catch(error => console.error(error));
```

If a batchSize option is given, the handler will be invoked between polling intervals and receive an array of jobs.

```js
boss.subscribe('email-welcome', {batchSize: 5}, jobs => {
    // do something with all jobs
    myEmailService.sendEmailToAll(jobs)
    jobs.forEach(job => job.done());
  })
  .then(() => console.log('subscription created'))
  .catch(error => console.error(error));
```

## State-based subscriptions

Sometimes when a job changes state, it's important enough to trigger other things that should react to it. The following functions work identically to `subscribe()` and allow you to create orchestrations or sagas between jobs that may or may not know about each other. This common messaging pattern allows you to keep multi-job flow logic out of the individual job handlers so you can manage things in a more centralized fashion while not losing your mind. As you most likely already know, asynchronous jobs are complicated enough already.

Internally, all state transitions are also jobs themselves (they have a special suffix of `__state__<state name>`).  Since pg-boss creates these, they are considered second class jobs and therefore not subject to the same expiration policies. In addition, the archiver ensures they don't hang around.

> There are some state changes that also trigger [events](#events), and this may be a bit confusing as there is a bit of overlapping concerns. Events can be convenient since you can have as many listeners as desired per event. However, emitting an event doesn't require any listeners, so if no callbacks are registered for them, you will never receive them as they are not persisted.

### `onComplete(name [, options], handler)`

State-based `subscribe()` for completed jobs.

The callback for `onComplete()` returns a job which contains a `request` and `response` property in its data property. The response property is the optional data argument in [`complete()`](#completeid--data).

This definitely calls for an example.  Here's a lovely example from the test suite showing this in action.

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
  "id": "54687d40-48f9-11e7-af1e-9bf165e06ad0",
  "name": "onCompleteFtw__state__complete",
  "data": {
    "request": {
      "id": "5466cf90-48f9-11e7-af1e-9bf165e06ad0",
      "data": {
        "token": "trivial"
      },
      "name": "onCompleteFtw"
    },
    "response": {
      "code": "1234",
      "message": "so verbose"
    }
  }
}
```

### `onExpire(name [, options], handler)`

State-based `subscribe()` for expired jobs.

The job provided by `onExpire()` is the original job.

### `onFail(name [, options], handler)`

State-based `subscribe()` for failed jobs.  

The callback for `onFail()` returns a job which contains a `request` and `response` property in its data property just like `onComplete()`. The response property is the optional data argument in [`fail()`](#failid--data).

## `unsubscribe(name)`

Removes a subscription by job name and stops polling.

### `offComplete(name)`

Same as `unsubscribe()`, but removes an `onComplete()` subscription.

### `offExpire(name)`

Same as `unsubscribe()`, but removes an `onExpire()` subscription.

### `offFail(name)`

Same as `unsubscribe()`, but removes an `onFail()` subscription.

## `fetch()`

Typically one would use `subscribe()` for automated polling for new jobs based upon a reasonable interval to finish the most jobs with the lowest latency. While `subscribe()` is a yet another free service we offer and it can be awfully convenient, sometimes you may have a special use case around when a job can be retrieved. Or, perhaps like me, you need to provide jobs via other entry points such as a web API.

`fetch()` allows you to skip all that polling nonsense that `subscribe()` does and puts you back in control of database traffic. Once you have your shiny job, you'll use either `complete()` or `fail()` to mark it as finished.

### `fetch(name)`

**Arguments**
- `name`: string, job name

**Resolves**
- `job`: job object, `null` if none found

### `fetch(name, batchSize)`

**Arguments**
- `name`: string, job name
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
    let promises = jobs.map(job => emailer.send(job.data).then(() => job.done()));

    return Promise.all(promises);      
  })
  .catch(error => console.log(error));
```

### `fetchCompleted(name [, batchSize])`

Same as `fetch()`, but retrieves any completed jobs. See [`onComplete()`](#oncompletename--options-handler) for more information.

### `fetchExpired(name [, batchSize])`

Same as `fetch()`, but retrieves any expired jobs. See [`onExpire()`](#onexpirename--options-handler) for more information.


### `fetchFailed(name [, batchSize])`

Same as `fetch()`, but retrieves any failed jobs.  See [`onFail()`](#onfailname--options-handler) for more information.

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

> For example, if you were to subscribe to `error` in instance A, it will not receive an `error` event from instance B.  The same concept applies to all events.  If a job is subscribed in instance A, the `job` event will be raised alongside the `subscribe()` callback only for instance A.  There is currently no such thing as a global `job` event across instances.

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

## `job`
When a job is processed, the subscriber's callback is called *and* a `job` event is raised.  Adding a listener to the job event is completely optional, but you may wish to use it for logging or tracking purposes per instance.

The payload is the same job object that the subscriber's handler function receives with id, name and data properties.

```js
boss.on('job', job => console.log(`Job ${job.name} (${job.id}) received by subscriber`));
```

## `failed`
`failed` is raised for job failures.  This event is triggered automatically if any unhandled errors occur in a `subscribe()`, or manually from `fail(jobId)` or `done(error)` within a subscriber callback.

The payload is an object with the job and the error:

```js
boss.on('failed', failure => {
  console.error(`Job ${failure.job.name} failed`);
  console.error(failure.error);
});
```

## `archived`

`archived` is raised each time 1 or more jobs are archived.  The payload is an integer representing the number of jobs archived.

> Please note the term **"archive"** used in pg-boss actually results in completed jobs being **removed** from the job table to keep performance and capacity under control.  If you need to keep old jobs, you should set the `archiveCompletedJobsEvery` setting large enough to allow yourself a window of opportunity to grab them ahead of their scheduled removal.

## `expired-count`

`expired-count` is raised each time 1 or more jobs are expired.  The payload is an integer representing the number of jobs expired.

## `expired-job`

Each time a job expires, `expired-job` is raised. Adding a listener to this event is completely optional, but you may wish to use it for global job logging or tracking purposes. The payload is the same job object that the subscriber's handler function receives with id, name and data properties.  If you need to react to job expirations for a particular job name, you should use `onExpire()` instead.

## `monitor-states`

The `monitor-states` event is conditionally raised based on the `monitorStateInterval` configuration setting.  If passed during instance creation, it will provide a count of jobs in each state per interval.  This could be useful for logging or even determining if the job system is handling its load.

The payload of the event is an object with state names and job count, such as the  following example.

```js
{
  "created": 530,
  "retry": 40,
  "active": 26,
  "complete": 3400,
  "expired": 4,
  "cancelled": 0,
  "failed": 49
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
