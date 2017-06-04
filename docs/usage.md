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
    - [`complete(id [, data])`](#completeid--data)
    - [`fail(id)`](#failid)
- [Events](#events)
    - [`error`](#error)
    - [`job`](#job)
    - [`failed`](#failed)
    - [`archived`](#archived)
    - [`expired-count`](#expired-count)
    - [`expired-job`](#expired-job)
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

If the CREATE privilege is not granted (so sad), you can still use the static function `PgBoss.getConstructionPlans()` method to export the SQL required to manually create the objects.  This also means you will also need to monitor future releases for schema changes (the schema property in [version.json](https://github.com/timgit/pg-boss/blob/master/version.json)) so they can be applied manually. In which case you'll also be interested in  `PgBoss.getMigrationPlans()`.

## `stop()`

**returns: Promise**

The opposite of `start()`.  All job monitoring will be stopped and all subscriptions on this instance will be removed.  For example, if you were to call `stop()`, then immediately call `start()` again, you would need to re-subscribe via `subscribe()` to begin receiving jobs.

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

> `publish()` will resolve a `null` for job id under some use cases when using [unique jobs](configuration.md#unique-jobs) or [throttling](configuration#throttled-jobs).  These options are always opt-in on the publish side and therefore don't result in a promise rejection.

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
|`done()` | function | callback function used to mark the job as completed or failed in the database. 

`done()` accepts an optional error argument in typical node fashion.  If an error is passed, it will mark the job as failed.

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

## State-based subscriptions

Sometimes when a job changes state, it's important enough to trigger other things that should react to it. The following functions work identically to `subscribe()` and allow you to create orchestrations or sagas between jobs that may or may not know about each other. This common messaging pattern allows you to keep multi-job flow logic out of the individual job handlers so you can manage things in a more centralized fashion while not losing your mind. As you most likely already know, asynchronous jobs are complicated enough already.

> Some state changes trigger events which 1 or more instances (or none!) may listen for.  You can read more about events below, but for now just keep in mind that an event doesn't care if anyone is listening on the other side, so you have no guarantees with them.  Using pg-boss subscriptions here is a guarantee that you can react to a state change per occurrence. 

### `onComplete(name [, options], handler)`

State-based `subscribe()` for completed jobs.

The callback for `onComplete()` returns a job that is a combination of the original request and the response. The response being the optional data argument in [`complete()`](#completeid--data).

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

> While similar to the `expired-job` event, `onExpire()` is actually an internally persisted job so it will survive a restart. You're welcome.

### `onFail(name [, options], handler)`

State-based `subscribe()` for failed jobs.

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

### `fetchCompleted(name [, batchSize])`

Same as `fetch()`, but retrieves any completed jobs. See [`onComplete()`](#oncompletename--options-handler) for more information.

### `fetchExpired(name [, batchSize])`

Same as `fetch()`, but retrieves any expired jobs. See [`onExpire()`](#onexpirename--options-handler) for more information.


### `fetchFailed(name [, batchSize])`

Same as `fetch()`, but retrieves any failed jobs.  See [`onFail()`](#onfailname--options-handler) for more information.

## `cancel(id)`

Cancels a pending job.  This would likely only be used for delayed jobs.

The promise will resolve on a successful cancel, or reject if the job could not be cancelled.

## `complete(id [, data])`

Completes an active job.  This would likely only be used with `fetch()`. Accepts an optional `data` argument for usage with [`onComplete()`](#oncompletename--options-handler) state-based subscriptions.

The promise will resolve on a successful completion, or reject if the job could not be completed.

## `fail(id)`

Marks an active job as failed.  This would likely only be used with `fetch()`.

The promise will resolve on a successful assignment of failure, or reject if the job could not be marked as failed.

# Events

## `error`
The error event is raised from any errors that may occur during internal job fetching, monitoring and archiving activities. While not required, adding a listener to the error event is strongly encouraged. Ideally, code such as the following would be used after creating your instance before `start()` or `connect()` is called.

```js
boss.on('error', error => logger.error(error));
```

**Note: Since error events are only raised during internal housekeeping activities, they are not raised for direct API calls, where promise `catch()` handlers should be used.**

## `job`
When a job is found and processed, the subscriber's callback is called *and* a `job` event is raised.  Adding a listener to the job event is completely optional, but you may wish to use it for global job logging or tracking purposes.  The payload is the same job object that the subscriber's handler function receives with id, name and data properties.

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

## `expired-count`

`expired-count` is raised each time 1 or more jobs are expired.  The payload is an integer representing the number of jobs expired.

## `expired-job`

Each time a job expires, `expired-job` is raised. Adding a listener to this event is completely optional, but you may wish to use it for global job logging or tracking purposes. The payload is the same job object that the subscriber's handler function receives with id, name and data properties.  If you need to react to job expirations for a particular job name, you should use `onExpire()` instead.

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
