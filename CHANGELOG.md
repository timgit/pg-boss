# Changes

## 4.0.0

### Features

- `start()` is now multi-master compatible for both schema migrations and maintenance operations.  For example, you could reliably and consistently run `start()` during bootstrapping of pods in a ReplicaSet in Kubernetes without any schema migration race conditions or risking runnig maintenance operations too often.
- MAJOR: Consolidated the maintenance constructor options and removed any options for intervals less than 1 second.  
  - Removed:
    - `expireCheckInterval`
    - `expireCheckIntervalSeconds`
    - `expireCheckIntervalMinutes`
    - `archiveCheckInterval`
    - `archiveCheckIntervalSeconds`
    - `archiveCheckIntervalMinutes`
    - `deleteCheckInterval`
  - Added:
    - `maintenacneIntervalSeconds`
    - `maintenanceIntervalMinutes`
  
### Context

The breaking changes introduced in this release should not cause any run-time failures, but if you are relying on customized maintenance intervals, you will need to adjust the configuration options when you upgrade.

To keep maintenance operations running as light as possible, concurrency of each item (expiration, archiving, deletion) has been adjusted to 1 operation at a time. In the process of doing this, I've also migrated all internal timers to queues, basically having pg-boss eat its own dog food.

This change was originally made to support rolling deployments where a new instance is being started before another instance is turned off.  If and when this were to occur, you may have a race condition of 2 maintenance operations attempting to execute at the same time, which has caused unpredictable deadlock errors (see [issue #133](https://github.com/timgit/pg-boss/issues/133)) because of the use of unordered data sets in CTEs from a `DELETE ... RETURNING` statement. Upon review, addressing the concurrency problem was a far better option than introducing more changes to how the actual sql statement is working.

The result of using a queue for maintenance instead of a timer is you can now run pg-boss in multi-master mode, where more than 1 instance is using `start()` simultaneously. If 2 or more instances are using `start()`, only 1 of them will be able to fetch the job (maintnenance or state monitoring) and issue the related SQL statements. 

Likewise, advisory locks have been placed around all schema opertaions to handle any potential race conditions during `start()`.  The advisory locks will wait on each other, only allowing one instance control over schema operations at a time.

## 3.2.2

- Deferring housekeeping operations on start to reduce deadlocks during concurrent start() instances

## 3.2.1

- Fixed rare deadlocks by stacking housekeeping operations one at a time during start().
- Added `archive()`, `purge()` and `expire()` to exports for manual housekeeping if desired along with connect().  Use this only if you need it for special cases, as it's not a good idea to run these in parallel (see deadlock comment above).
- Added index to archive table by date to improve housekeeping perf.
- Node 8 is now officially the minimum supported version.  Not only have I stopped testing anything lower than 8 in Travis, but I finally migrated to async await in this round of changes.
- Typescript type defs.

## 3.1.7

- Typescript type defs for singletonNextSlot config updated via PR.

## 3.1.6

- Typescript type defs for deletion config updated via PR.

## 3.1.5

- Typescript type defs updated for job priority via PR.
- Set default `teamConcurrency` to 1 when `teamSize` > 1.

## 3.1.4

- Typescript type defs updated for static function exports via PR.

## 3.1.3

- Added support for typeorm with job insertion script via PR. 

## 3.1.2

- Prevented duplicate state completion jobs being created from an expired onComplete() subscription.

## 3.1.1

- Typescript defs patch

## 3.1.0

### Features
- Added wildcard pattern matching for subscriptions. The allows you to have 1 subscription over many queues. For example, the following subscription uses the `*` placeholder to fetch completed jobs from all queues that start with the text `sensor-report-`.

  ```js
    boss.onComplete('sensor-report-*', processSensorReport);
  ```
  Wildcards may be placed anywhere in the queue name. The motivation for this feature is adding the capability for an orchestration to use a single subscription to listen to potentially thousands of job processors that just have 1 thing to do via isolated queues.

### Changes
- Multiple subscriptions to the same queue are now allowed on the same instance.
  
  Previously an error was thrown when attempting to subscribe to the same queue more than once on the same instance. This was merely an internal concern with worker tracking. Since `teamConcurrency` was introduced in 3.0, it blocks polling until the last job in a batch is completed, which may have the side effect of slowing down queue operations if one job is taking a long time to complete. Being able to have multiple subscriptions isn't necessarily something I'd advertise as a feature, but it's something easy I can offer until implementing a more elaborate producer consumer queue pattern that monitors its promises.
  
  Remember to keep in mind that `subscribe()` is intended to provide a nice abstraction over `fetch()` and `complete()`, which are always there if and when you require a use case that `subscribe()` cannot provide.
  
- Internal state job suffixes are now prefixes. The following shows a comparison of completed state jobs for the queue `some-job`.

  - 3.0: `some-job__state__completed`
  - 3.1: `__state__completed__some-job`

  This is a internal implementation detail included here if you happen to have any custom queries written against the job tables. The migration will handle this for the job table (the archive will remain as-is).
  
### Fixes
- Removed connection string parsing and validation.  The pg module bundles [pg-connection-string](https://github.com/iceddev/pg-connection-string) which supports everything I was trying to do previously with connection strings. This resolves some existing issues related to conditional connection arguments as well as allowing auto-promotion of any future enhancements that may be provided by these libraries.

## :tada: 3.0.0 :tada:

### Additions and Enhancements

- Retry support added for failed jobs!  Pretty much the #1 feature request of all time.
- Retry delay and backoff options added!  Expired and failed jobs can now delay a retry by a fixed time, or even a jittered exponential backoff.
  - New publish options: `retryDelay` (int) and `retryBackoff` (bool)
  - `retryBackoff` will use an exponential backoff algorithm with jitter to somewhat randomize the distribution. Inspired by Marc on the AWS blog post [Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- Backpressure support added to `subscribe()`! If your callback returns a promise, it will defer polling and other callbacks until it resolves.
  - Returning a promise replaces the need to use the job.done() callback, as this will be handled automatically. Any errors thrown will also automatically fail the job.
  - A new option `teamConcurrency` was added that can be used along with `teamSize` for single job callbacks to control backpressure if a promise is returned. 
- `subscribe()` will now return an array of jobs all at once when `batchSize` is specified.
- `fetch()` now returns jobs with a convenience `job.done()` function like `subscribe()`
- Reduced polling load by consolidating all state-based completion subscriptions to `onComplete()`
  - Want to know if the job failed?  `job.data.failed` will be true.
  - Want to know if the job expired?  `job.data.state` will be `'expired'`.
  - Want to avoid hard-coding that constant? All state names are now exported in the root module and can be required as needed, like in the following example.
     ```js
     const {states} = require('pg-boss');
     
     if(job.data.state === states.expired) {
         console.log(`job ${job.data.request.id} in queue ${job.data.request.name} expired`);
         console.log(`createdOn: ${job.data.createdOn}`);     
         console.log(`startedOn: ${job.data.startedOn}`);     
         console.log(`expiredOn: ${job.data.completedOn}`);
         console.log(`retryCount: ${job.data.retryCount}`);
     }
     ```
- Batch failure and completion now create completed state jobs for `onComplete()`.  Previously, if you called complete or fail with an array of job IDs, no state jobs were created.
- Added convenience publish functions that set different configuration options:
  - `publishThrottled(name, data, options, seconds, key)` 
  - `publishDebounced(name, data, options, seconds, key)`
  - `publishAfter(name, data, options, seconds | ISO date string | Date)`
  - `publishOnce(name, data, options, key)`
- Added `deleteQueue()` and `deleteAllQueues()` api to clear queues if and when needed.

### Semver major items & breaking changes
- Removed all events that emitted jobs, such as `failed`, `expired-job`, and `job`, as these were all instance-bound and pre-dated the distribution-friendly `onComplete()`
- Removed extra convenience `done()` argument in `subscribe()` callback in favor of consolidating to `job.done()`
- Renamed `expired-count` event to `expired`
- Failure and completion results are now wrapped in an object with a value property if they're not an object
- `subscribe()` with a `batchSize` property now runs the callback only once with an array of jobs. The `teamSize` option still calls back once per job.
- Removed `onFail()`, `offFail()`, `onExpire()`, `onExpire()`, `fetchFailed()` and `fetchExpired()`.  All job completion subscriptions should now use `onComplete()` and fetching is consolidated to `fetchCompleted()`. In order to determine how the job completed, additional helpful properties have been added to `data` on completed jobs, such as `state` and `failed`.
- `startIn` option has been renamed to `startAfter` to make its behavior more clear.  Previously, this value accepted an integer for the number of seconds of delay, or a PostgreSQL interval string.  The interval string has been replaced with an UTC ISO date time string (must end in Z), or you can pass a Date object.
- `singletonDays` option has been removed
- Dropping node 4 support.  All tests in 3.0 have passed in CI on node 4, but during release I removed the Travis CI config for it, so future releases may not work.

### Fixes and other items of interest
- The pgcrypto extension is now used internally for uuid generation with onComplete().  It will be added in the database if it's not already added.
- Adjusted indexes to help with fetch performance
- Errors thrown in job handlers will now correctly serialize into the response property of the completion job.

## 2.5.2

- Typescript defs patch

## 2.5.1

- Added `max` constructor option additional to `poolSize`
- Migration: use pg transaction to avoid inconsistency


## 2.5.0
 
- Archive: Existing archive configuration settings now apply to moving jobs into a new table `arvhive` 
instead of immediate deletion. This allows the concerns of job indexing and job retention to be separated.
- Archive: `deleteArchivedJobsEvery` and `deleteCheckInterval` settings added for defining job retention. 
The default retention interval is 7 days.
- Archive: Changed default archive interval to 1 hour from 1 day.
- Monitoring: Updated contract for `monitor-states` event to add counts by queue, not just totals.
- Monitoring: Adjusted queue size counting to exclude state-based jobs.  While these were technically 
correct in regards to physical record count, it was a bit too difficult to explain.  
- Downgraded bluebird to a dev dependency. Always nice to have 1 less dependency.

## 2.4.3

- Typescript defs patch

## 2.4.2

- Typescript defs patch

## 2.4.1

- Typescript defs patch

## 2.4.0

- Added constructor option `db` for using an external/existing database connection.  
This bypasses having to create an additional connection pool.

## 2.3.4

- Patch to prevented state transition jobs from being created from existing state transition jobs.  
Kind of meta.  These were unfetchable and therefor just clutter.  

## 2.3.3

- Patch to allow custom schema name with a connectionString constructor option.

## 2.3.2

- Patch to fix missing error on `failed` event.  via PR #37.

## 2.3.1

- Patch to fix typescript types path

## 2.3.0

- Typescript defs

## 2.2.0

- Patched pg driver to 7.1

## 2.1.0

- Upgrade pg driver to 7.0

## 2.0.0

- Added state transition jobs and api for orchestration/saga support. 
- Added job fetch batching

## 1.1.0

- Added `onExpire(jobName, callback)` for guaranteed handling of expiration (not just an event anymore)
- `failed` was added as a job status 
- now emits 'failed' on unhandled subscriber errors instead of 'error', which is far safer 
- `done()` in `suscribe()` callbacks now support passing an error (the popular node convention) to 
automatically mark the job as failed as well as emitting failed.  For example, 
if you are processing a job and you want to explicitly mark it as failed, you can just call `done(error)` at any time.
- `fail(jobId)` added for external failure reporting along with `fetch()` and `complete()`
- `unsubscribe(jobName)` added to undo a `subscribe()`

## 1.0.0

- Dropped support for node 0.10 and 0.12
- Added new publish option called `singletonKey` was added in order to make sure only 1 job of a certain type is active, queued or in a retry state
- Added new publish option called `singletonNextSlot` was added in order to make sure a job is processed eventually, even if it was throttled down (not accepted). 
Basically, this is debouncing with a lousy name, because I'm not very good at naming things and didn't realize it at time 
- Added `newJobCheckInterval` and `newJobCheckIntervalSeconds` to `subscribe()` instead of just in the constructor
- Added `poolSize` constructor option to explicitly control the maximum number of connections that can be used against the specified database
- 0.x had a data management bug which caused expired jobs to not be archived and remain in the job table.  
I also added a fix to the migration script so if you had any old expired jobs they should be automatically archived.
- Error handling in subscriber functions! 
Previously I've encouraged folks to handle their own errors with try catch and be as defensive as possible in 
callback functions passed to `subscribe()`.  
However, it was too easy to miss that at times and if an error occurred that wasn't caught, 
it had the pretty lousy side effect of halting all job processing. 
1.0.0 now wraps all subscriber functions in try catch blocks and emits the 'error' event if one is encountered.  
