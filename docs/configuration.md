# Configuration <!-- omit in toc -->

pg-boss can be customized using configuration options when an instance is created (the constructor argument), during publishing as well as subscribing.

<!-- TOC -->

- [Constructor options](#constructor-options)
  - [Database options](#database-options)
  - [Queue options](#queue-options)
  - [Maintenance options](#maintenance-options)
    - [Delete archived jobs](#delete-archived-jobs)
    - [Maintenance interval](#maintenance-interval)
- [Publish options](#publish-options)
  - [Retry options](#retry-options)
  - [Expiration options](#expiration-options)
  - [Retention options](#retention-options)
  - [Deferred jobs](#deferred-jobs)
  - [Unique jobs](#unique-jobs)
  - [Throttled jobs](#throttled-jobs)
- [Fetch options](#fetch-options)
- [Subscribe options](#subscribe-options)
  - [Job polling options](#job-polling-options)

<!-- /TOC -->

## Constructor options

The constructor accepts either a string or an object.  If a string is used, it's interpreted as a PostgreSQL connection string based on the [pg](https://github.com/brianc/node-postgres) package. For example:

```js
const boss = new PgBoss('postgres://user:pass@host:port/database?ssl=require');
```

Alternatively, the following options can be set as properties in an object.


### Database options

* **host** - string,  defaults to "127.0.0.1"

* **port** - int,  defaults to 5432

* **ssl** - boolean or object

* **database** - string, *required*

* **user** - string, *required*

* **password** - string

* **connectionString** - string

  PostgreSQL connection string will be parsed and used instead of `host`, `port`, `ssl`, `database`, `user`, `password`.

* **max** - int, defaults to 10

  Maximum number of connections that will be shared by all subscriptions in this instance

* **application_name** - string, defaults to "pgboss"

* **db** - object

    Passing an object named db allows you "bring your own database connection".
    Setting this option ignores all of the above settings. The interface required for db is a single function called `executeSql` that accepts a SQL string and an optional array of parameters. This should return a promise that resolves an object just like the pg module: a `rows` array with results and `rowCount` property that contains affected records after an update operation.

    ```js
    {
      // resolves Promise
      executeSql(text, [value])
    }
    ```

    This option may be beneficial if you'd like to use an existing database service
    with its own connection pool.

    For example, you may be relying on the cluster module on
    a web server, and you'd like to limit the growth of total connections as much as possible.

* **schema** - string, defaults to "pgboss"

    Database schema that contains all required storage objects. Only alphanumeric and underscore allowed, length: <= 50 characters

### Queue options

Queue options contain the following constructor-only settings.

* **uuid** - string, defaults to "v1"

    job uuid format used, "v1" or "v4"

**State count monitoring**

* **monitorStateIntervalSeconds** - int, default undefined

    Specifies how often in seconds an instance will fire the `monitor-states` event. Must be >= 1.

* **monitorStateIntervalMinutes** - int, default undefined

    Specifies how often in minutes an instance will fire the `monitor-states` event. Must be >= 1.

  > When a higher unit is is specified, lower unit configuration settings are ignored.


### Maintenance options

Maintenance operations include checking active jobs for expiration, archiving completed jobs from the primary job table, and deleting archived jobs from the archive table.

* **noSupervisor**, bool, default false

  If this is set to true, maintenance and monitoring operations will not be started during a `start()` after the schema is created.  This is an advanced use case, as bypassing maintenance operations is not something you would want to do under normal circumstances.

* **noScheduling**, bool, default false

  If this is set to true, this instance will not monitor scheduled jobs during `start()`. However, this instance can still use the scheduling api. This is an advanced use case you may want to do for testing or if the clock of the server is skewed and you would like to disable the skew warnings.

#### Delete archived jobs

When jobs in the archive table become eligible for deletion.

* **deleteAfterSeconds**, int

    delete interval in seconds, must be >=1

* **deleteAfterMinutes**, int

    delete interval in minutes, must be >=1

* **deleteAfterHours**, int

    delete interval in hours, must be >=1

* **deleteAfterDays**, int

    delete interval in days, must be >=1

Default: 7 days

> When a higher unit is is specified, lower unit configuration settings are ignored.

#### Maintenance interval

How often maintenance operations are run against the job and archive tables.

* **maintenanceIntervalSeconds**, int

    maintenance interval in seconds, must be >=1

* **maintenanceIntervalMinutes**, int

    interval in minutes, must be >=1

Default: 1 minute

> When a higher unit is is specified, lower unit configuration settings are ignored.

## Publish options

* **priority**, int

    optional priority.  Higher numbers have, um, higher priority

### Retry options

Available in constructor as a default, or per-job in `publish()` and related publish convenience functions.

* **retryLimit**, int

    Default: 0. Max number of retries of failed jobs. Default is no retries.

* **retryDelay**, int

    Default: 0. Delay between retries of failed jobs, in seconds.

* **retryBackoff**, bool

    Default: false. Enables exponential backoff retries based on retryDelay instead of a fixed delay. Sets initial retryDelay to 1 if not set.

### Expiration options

* **expireInSeconds**, number

    How many seconds a job may be in active state before it is failed because of expiration. Must be >=1

* **expireInMinutes**, number

    How many minutes a job may be in active state before it is failed because of expiration. Must be >=1

* **expireInHours**, number

    How many hours a job may be in active state before it is failed because of expiration. Must be >=1

Default: 15 minutes

> When a higher unit is is specified, lower unit configuration settings are ignored.


### Retention options

* **retentionSeconds**, number

    How many seconds a job may be in created state before it's archived. Must be >=1

* **retentionMinutes**, number

    How many minutes a job may be in created state before it's archived. Must be >=1

* **retentionHours**, number

    How many hours a job may be in created state before it's archived. Must be >=1

* **retentionDays**, number

    How many days a job may be in created state before it's archived. Must be >=1

Default: 30 days

> When a higher unit is is specified, lower unit configuration settings are ignored.


### Deferred jobs
* **startAfter** int, string, or Date
  * int: seconds to delay starting the job
  * string: Start after a UTC Date time string in 8601 format
  * Date: Start after a Date object

    Default: 0

### Unique jobs
* **singletonKey** string

Only allows 1 job (within the same name) to be queued or active with the same singletonKey.

```js
boss.publish('my-job', {}, {singletonKey: '123'}) // resolves a jobId
boss.publish('my-job', {}, {singletonKey: '123'}) // resolves a null jobId until first job completed
```

This can be used in conjunction with throttling explained below.

### Throttled jobs
* **singletonSeconds**, int
* **singletonMinutes**, int
* **singletonHours**, int
* **singletonNextSlot**, bool

Throttling jobs to 'once every n units', where units could be seconds, minutes, or hours.  This option is set on the publish side of the API since jobs may or may not be created based on the existence of other jobs.

For example, if you set the `singletonMinutes` to 1, then submit 2 jobs within a minute, only the first job will be accepted and resolve a job id.  The second request will be discarded, but resolve a null instead of an id.

> When a higher unit is is specified, lower unit configuration settings are ignored.

Setting `singletonNextSlot` to true will cause the job to be scheduled to run after the current time slot if and when a job is throttled. This option is set to true, for example, when calling the convenience function `publishDebounced()`.

## Fetch options

* **includeMetadata**, bool

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

## Subscribe options

* **teamSize**, int

    Default: 1. How many jobs can be fetched per polling interval. Callback will be executed once per job.

* **teamConcurrency**, int

    Default: 2. How many callbacks will be called concurrently if promises are used for polling backpressure. Intended to be used along with `teamSize`.

* **batchSize**, int

    How many jobs can be fetched per polling interval.  Callback will be executed once per batch.

* **includeMetadata**, bool

    Same as above in fetch options

### Job polling options

How often subscriptions will poll the queue table for jobs. Available in the constructor as a default or per subscription in `subscribe()` and `onComplete()`.

* **newJobCheckInterval**, int

  Interval to check for new jobs in milliseconds, must be >=100

* **newJobCheckIntervalSeconds**, int

  Interval to check for new jobs in seconds, must be >=1

Default: 2 seconds

> When a higher unit is is specified, lower unit configuration settings are ignored.
