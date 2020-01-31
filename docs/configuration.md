Configuration
=============

pg-boss can be customized using configuration options when an instance is created (the constructor argument), during publishing as well as subscribing.

<!-- TOC -->

- [Configuration](#configuration)
  - [Constructor Options](#constructor-options)
    - [Database options](#database-options)
    - [Queue options](#queue-options)
    - [Maintenance options](#maintenance-options)
  - [Publish Options](#publish-options)
    - [Delayed jobs](#delayed-jobs)
    - [Unique jobs](#unique-jobs)
    - [Throttled jobs](#throttled-jobs)
    - [Job retries](#job-retries)
    - [Job expiration](#job-expiration)
  - [Subscribe Options](#subscribe-options)

<!-- /TOC -->

## Constructor Options

The constructor accepts either a string or an object.  If a string is used, it's interpreted as a Postgres connection string.
Since passing only a connection string is intended to be for convenience, you can't set any other options.   

### Database options

* **host** - string,  defaults to "127.0.0.1"

* **port** - int,  defaults to 5432

* **ssl** - bool, defaults to false

* **database** - string, *required*

* **user** - string, *required*

* **password** - string

* **connectionString** - string

    PostgresSQL connection string will be parsed and used instead of `host`, `port`, `ssl`, `database`, `user`, `password`.
    Based on the [pg](https://github.com/brianc/node-postgres) package. For example: 
    
    ```js
    const boss = new PgBoss('postgres://user:pass@host:port/database?ssl=require');
    ```

* **poolSize** or **max** - int, defaults to 10

    Maximum number of connections that will be shared by all subscriptions in this instance
    
* **application_name** - string, defaults to "pgboss"
    
* **db** - object

    Passing an object named db allows you "bring your own database connection".  
    Setting this option ignores all of the above settings. The interface required for db is a single function called `executeSql` that accepts a SQL string and an optional array of parameters. This should return a promise that resolves an object just like the pg module: a `rows` array with results and `rowCount` property that contains affected records after an update operation.
    
    ```js
    {
      // resolves Promise
      executeSql(text, [values])    
    }
    ```
    
    This option may be beneficial if you'd like to use an existing database service 
    with its own connection pool.
    
    For example, you may be relying on the cluster module on 
    a web server, and you'd like to limit the growth of total connections as much as possible. 

* **schema** - string, defaults to "pgboss"

    Only alphanumeric and underscore allowed, length: <= 50 characters

### Queue options

* **uuid** - string, defaults to "v1"

    job uuid format used, "v1" or "v4"

* **monitorStateIntervalSeconds** - int, default undefined

    Specifies how often in seconds an instance will fire the `monitor-states` event. Cannot be less than 1.  This is only available 

* **monitorStateIntervalMinutes** - int, default undefined

    Specifies how often in minutes an instance will fire the `monitor-states` event. Cannot be less than 1. Do not use if using `monitorStateIntervalSeconds`.

* **newJobCheckInterval**, int

    interval to check for new jobs in milliseconds, must be >=100

* **newJobCheckIntervalSeconds**, int

    Default: 1. interval to check for new jobs in seconds, must be >=1

> When `newJobCheckIntervalSeconds` is specified, `newJobCheckInterval` is ignored.

### Maintenance options

Maintenance operations include checking active jobs for expiration, archiving completed jobs from the primary job table, and deleting archived jobs from the archive table.  

* **noSupervisor**, bool, default undefined
  
  If this is set to true, maintenance operations will not be started during a `start()` after the schema is created.  This is an advanced use case, as bypassing maintenance operations is not something you would want to do under normal circumstances.  It's here if you need it, however.

* **archiveCompletedJobsEvery**, string, [PostgreSQL interval](https://www.postgresql.org/docs/9.5/static/datatype-datetime.html#DATATYPE-INTERVAL-INPUT)

    Default: "1 hour".  When jobs become eligible for archive after completion.

* **deleteArchivedJobsEvery**, string, [PostgreSQL interval](https://www.postgresql.org/docs/9.5/static/datatype-datetime.html#DATATYPE-INTERVAL-INPUT)

    Default: "7 days".  When jobs in the archive table become eligible for deletion.

* **maintenanceIntervalSeconds**, int

    maintenance interval in seconds, must be >=1

* **maintenanceIntervalMinutes**, int

    Default: 1. interval in minutes, must be >=1

> When `maintenanceIntervalMinutes` is specified, `maintenanceIntervalSeconds` and `maintenanceInterval` are ignored. 
>
> When `maintenanceIntervalSeconds` is specified, `maintenanceInterval` is ignored.


## Publish Options

* **priority**, int

    optional priority.  Higher numbers have, um, higher priority

### Delayed jobs
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

Order of precedence for throttling is least to greatest. For example, if `singletonSeconds` is set, `singletonMinutes` is ignored.

Setting `singletonNextSlot` to true will cause the job to be scheduled to run after the current time slot if and when a job is throttled.  Basically it's debounce with a lousy name atm.  Expect this api to be improved in the future.  

### Job retries

* **retryLimit**, int

    Default: 0. Max number of retries of failed jobs. Default is no retries.

* **retryDelay**, int

    Default: 0. Delay between retries of failed jobs, in seconds.

* **retryBackoff**, bool

    Default: false. Enables exponential backoff retries based on retryDelay instead of a fixed delay. Sets initial retryDelay to 1 if not set.

### Job expiration

* **expireIn**, string, PostgreSQL interval

    Default: 15 minutes

## Subscribe Options

* **teamSize**, int

    Default: 1. How many jobs can be fetched per polling interval. Callback will be executed once per job.

* **teamConcurrency**, int

    Default: 2. How many callbacks will be called concurrently if promises are used for polling backpressure. Intended to be used along with `teamSize`.

* **batchSize**, int

    How many jobs can be fetched per polling interval.  Callback will be executed once per batch.

* **newJobCheckInterval**, int

    Polling interval to check for new jobs in milliseconds. Must be >=100 because we care about your database here in pg-boss land.

* **newJobCheckIntervalSeconds**, int

    Default: 1. interval to check for new jobs in seconds. Must be >=1

  When `newJobCheckIntervalSeconds` is specified, `newJobCheckInterval` is ignored.
