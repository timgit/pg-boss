# API

## `new(string)`

```js
const boss = new PgBoss('postgres://user:pass@host/database');
```

Passing a string argument to the constructor implies a PostgreSQL connection string in one of the formats specified by the [pg](https://github.com/brianc/node-postgres) package.  Some examples are currently posted in the [pg docs](https://github.com/brianc/node-postgres/wiki/pg).

## `new(object)`

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

Passing an object argument supports [advanced initialization options](configuration.md#constructor-options).

Since the new() operator is used, this method is synchronous and used primarily for option parsing and validation.  Any errors in configuration are thrown, so a try catch is encouraged. In order to begin using pg-boss, you'll need to use either `start()` or `connect()`;

## `start()`

**returns: Promise** *(resolves the same PgBoss instance used during invocation for convenience) *

```js
boss.start()
  .then(boss => {
    boss.publish('hey-there', {msg:'this came for you'});
  });
```

**`start()` should be called once and only once per backing database store.** It is responsible for monitoring jobs and triggers expiration and archiving activities.

If the required database objects do not exist in the specified database, **`start()` will automatically create them**. In order for this step to be successful, the specified user account will need the [CREATE](http://www.postgresql.org/docs/9.5/static/sql-grant.html) privilege. For example, the following command grants this privilege.

```sql
GRANT CREATE ON DATABASE ReallyImportantDb TO mostvaluableperson;
```

If the CREATE privilege is not granted (so sad), you can still use the static function `PgBoss.getConstructionPlans()` method to export the SQL required to manually create the objects.  Keep in mind you will also need to monitor future releases for schema changes (schema property in [version.json](https://github.com/timgit/pg-boss/blob/master/version.json)) so they can be applied manually. In which case you'll also be interested in  `PgBoss.getMigrationPlans()`.

## `stop()`
The opposite of `start()`.  All job monitoring will be stopped and workers will no longer raise job events.

## `connect()`

**returns: Promise** *(resolves the same PgBoss instance used during invocation for convenience)*

`connect()` is used for secondary workers running in other processes or servers, with the assumption that `start()` was previously used against this database instance. `connect()` doesn't start job expiration monitoring or archiving intervals like `start()`.

## `disconnect()`

**returns: Promise**

The opposite of `connect()`.  All workers will no longer raise job events.

## `publish()`

### Arguments
- **name**: string, job name  
- **data**: object, job data  
- **options**: object, [publish options](https://github.com/timgit/pg-boss/wiki/Configuration#publish-options)

##### Resolves
- **id**: string, job uuid, *(id may be null when using [unique jobs](https://github.com/timgit/pg-boss/wiki/Configuration#unique-jobs) or [throttling](https://github.com/timgit/pg-boss/wiki/Configuration#throttled-jobs))*

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

#### *promise* `publish(object request)`

##### Arguments
- **request**: object
  - `name`: string
  - `data`: object
  - `options`: object, [publish options](https://github.com/timgit/pg-boss/wiki/Configuration#publish-options)

##### Resolves
- **id**: string, job uuid, *(id may be null when using [unique jobs](https://github.com/timgit/pg-boss/wiki/Configuration#unique-jobs) or [throttling](https://github.com/timgit/pg-boss/wiki/Configuration#throttled-jobs))*

This overload of publish() is for conditionally including data or options based on keys in an object, such as the following.

```js
boss.publish({
  name: 'database-backup',
  options: { retryLimit: 1 }
})
.then(jobId => console.log(`job ${jobId} submitted`));
```

#### *promise* `subscribe(string name, [object options,] function(job, callback) handler)`

##### Arguments
- name: string, job name
- options: optional object, [job subscribe options](https://github.com/timgit/pg-boss/wiki/Configuration#subscribe-options)
- handler: function(job, callback)


subscribe() will resolve on a successful subscription, or reject if the request failed for any reason.

handler will have 2 args, job and callback. The job object will have id, name and data properties, and the callback function should be used to mark the job as completed in the database.  If you forget to use the callback to mark the job as completed, it will expire after the configured expiration period.  The default expiration can be found in the [configuration docs](https://github.com/timgit/pg-boss/wiki/Configuration#job-expiration).

#### *promise* `onExpire(string name, function(job) handler)`

##### Arguments
- name: string, job name
- handler: function(job)

Subscribes to expired jobs by name. onExpire() resolves on a successful expiration subscription, or rejects if the request failed for any reason. Unlike the emitted event 'expired-job', `onExpire()` is actually an internally persisted job so it will survive a restart. You're welcome.

#### *promise* `cancel(string id)`

Cancels a pending job.  This would likely only be used for delayed jobs.

The promise will resolve on a successful cancel, or reject if the job could not be cancelled.

#### *promise* `fetch(string name)`

##### Arguments
- **name**: string, job name

##### Resolves
- **job**: job object, `null` if none found

Fetches a job by name.  If a job is available it will be returned.  Otherwise `null` will be returned.  

Typically, you'd use `subscribe()` for automated processing for new jobs by a team of internal workers within pg-boss.  However, you may wish to provide jobs via other entry points, such as a web API. If a job is fetched manually, you will also need to use `complete()` to mark it as completed or it will be flagged as expired after the configured timeout.

#### *promise* `complete(string id)`

Completes an active job.  This would likely only be used with `fetch()`.

The promise will resolve on a successful completion, or reject if the job could not be completed.

#### *promise* `fail(string id)`

Marks an active job as failed.  This would likely only be used with `fetch()`.

The promise will resolve on a successful assignment of failure, or reject if the job could not be marked as failed.

## Events
#### `error`
The error event is raised from any errors that may occur during internal job fetching, monitoring and archiving activities. While not required, adding a listener to the error event is strongly encouraged. Ideally, code such as the following would be used after creating your instance before `start()` or `connect()` is called.

```js
boss.on('error', error => logger.error(error));
```

**Note: Since error events are only raised during internal housekeeping activities, they are not raised for direct API calls, where promise `catch()` handlers should be used.**

#### `job`
When a job is found and processed, the subscriber's callback is called *and* a `job` event is raised.  Adding a listener to the job event is completely optional, but you may wish to use it for global job logging or tracking purposes.  The payload is the same job object that the subscriber's handler function receives with id, name and data properties.

#### `failed`
`failed` is raised for job failures.  This event is triggered automatically if any unhandled errors occur in a `subscribe()`, or manually from `fail(jobId)` or `done(error)` within a subscriber callback.

The payload is an object with the job and the error:

```js
boss.on('failed', failure => {
  console.error(`Job ${failure.job.name} failed`);
  console.error(failure.error);
});
```

#### `archived`

`archived` is raised each time 1 or more jobs are archived.  The payload is an integer representing the number of jobs archived.

#### `expired-count`

`expired-count` is raised each time 1 or more jobs are expired.  The payload is an integer representing the number of jobs expired.

#### `expired-job`

Each time a job expires, `expired-job` is raised. Adding a listener to this event is completely optional, but you may wish to use it for global job logging or tracking purposes. The payload is the same job object that the subscriber's handler function receives with id, name and data properties.  If you need to react to job expirations for a particular job name, you should use `onExpire()` instead.

## Static functions

The following static functions are not required during normal operations, but are intended to assist in schema creation or migration if run-time privileges do not allow schema changes.

#### `string getConstructionPlans(string schema)`

##### Arguments
- schema: string, database schema name

Returns the SQL commands required for manual creation of the required schema.

#### `string getMigrationPlans(string schema, string version, boolean uninstall)`

##### Arguments
- schema: string, database schema name
- version: string, target schema version to migrate
- uninstall: boolean, reverts to the previous version if true

Returns the SQL commands required to manually migrate to or from the specified version.
