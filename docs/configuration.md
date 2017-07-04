Configuration
=============

pg-boss can be customized using configuration options when an instance is created (the constructor argument), during publishing as well as subscribing.

<!-- TOC -->

- [Constructor Options](#constructor-options)
    - [Database options](#database-options)
    - [Job fetch options](#job-fetch-options)
    - [Job expiration options](#job-expiration-options)
    - [Job archive options](#job-archive-options)
- [Publish Options](#publish-options)
    - [Delayed jobs](#delayed-jobs)
    - [Unique jobs](#unique-jobs)
    - [Throttled jobs](#throttled-jobs)
    - [Job retries](#job-retries)
    - [Job expiration](#job-expiration)
- [Subscribe Options](#subscribe-options)

<!-- /TOC -->

## Constructor Options

### Database options
* **database** - string, *required*
* **user** - string, *required*
* **password** - string, *required*
* **host** - string

    Default: "127.0.0.1"

* **port** - int

    Default: 5432

* **schema** - string

    Default: "pgboss".  Only alphanumeric and underscore allowed, length: <= 50 characters

* **uuid** - string

    Default: "v1". uuid format used, "v1" or "v4"

* **poolSize** - int

    Default: 10.  Maximum number of connections that will be shared by all subscriptions in this instance.

### Job fetch options
* **newJobCheckInterval**, int

    interval to check for new jobs in milliseconds, must be >=100

* **newJobCheckIntervalSeconds**, int

    Default: 1. interval to check for new jobs in seconds, must be >=1

When `newJobCheckIntervalSeconds` is specified, `newJobCheckInterval` is ignored.

### Job expiration options
* **expireCheckInterval**, int

    interval to expire jobs in milliseconds, must be >=100

* **expireCheckIntervalSeconds**, int

    interval to expire jobs in seconds, must be >=1

* **expireCheckIntervalMinutes**, int

    Default: 1. interval to expire jobs in minutes, must be >=1

When `expireCheckIntervalMinutes` is specified, `expireCheckIntervalSeconds` and `expireCheckInterval` are ignored.

When `expireCheckIntervalSeconds` is specified, `expireCheckInterval` is ignored.

### Job archive options

> Please note the term **"archive"** used in pg-boss actually results in completed jobs being **removed** from the job table to keep performance and capacity under control.  If you need to keep old jobs, you should set the `archiveCompletedJobsEvery` setting large enough to allow yourself a window of opportunity to grab them ahead of their scheduled removal.

* **archiveCompletedJobsEvery**, string, [PostgreSQL interval](https://www.postgresql.org/docs/9.5/static/datatype-datetime.html#DATATYPE-INTERVAL-INPUT)

    Default: "1 day".  When jobs become eligible for archive after completion.

* **archiveCheckInterval**, int

    interval to archive jobs in milliseconds, must be >=100

* **archiveCheckIntervalSeconds**, int

    interval to archive jobs in seconds, must be >=1

* **archiveCheckIntervalMinutes**, int

    Default: 60. interval to archive jobs in minutes, must be >=1

When `archiveCheckIntervalMinutes` is specified, `archiveCheckIntervalSeconds` and `archiveCheckInterval` are ignored.

When `archiveCheckIntervalSeconds` is specified, `archiveCheckInterval` is ignored.

## Publish Options

### Delayed jobs
* **startIn** int or string
  * int: seconds to delay starting the job
  * string: PostgreSQL interval to delay starting the job

    Default: 0

### Unique jobs
* **singletonKey** string

Only allows 1 job (within the same name) to be queued or active with the same singletonKey.

```js
publish('my-job', {singletonKey: '123'}) // resolves a jobId 
publish('my-job', {singletonKey: '123'}) // resolves a null jobId until first job completed
```

This can be used in conjunction with throttling explained below.

### Throttled jobs
* **singletonSeconds**, int
* **singletonMinutes**, int
* **singletonHours**, int
* **singletonDays**, int

Throttling jobs to 'once every n units', where units could be seconds, minutes, hours or days.  This option is set on the publish side of the API since jobs may or may not be created based on the existence of other jobs.

For exampe, if you set the `singletonMinutes` to 1, then submit 2 jobs within a minute, only the first job will be accepted and resolve a job id.  The second request will be discarded, but resolve a null instead of an id.

Order of precedence for throttling is least to greatest. For example, if `singletonSeconds` is set, `singletonMinutes` is ignored.

### Job retries

* **retryLimit**, int

    Default: 0

### Job expiration

* **expireIn**, string, PostgreSQL interval

    Default: 15 minutes

## Subscribe Options

* **teamSize** or **batchSize**, int

    Default: 1. How many jobs will be fetched per polling interval.  

* **newJobCheckInterval**, int

    Polling interval to check for new jobs in milliseconds. Must be >=100 because we care about your database here in pg-boss land.

* **newJobCheckIntervalSeconds**, int

    Default: 1. interval to check for new jobs in seconds. Must be >=1

  When `newJobCheckIntervalSeconds` is specified, `newJobCheckInterval` is ignored.
