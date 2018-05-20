# Changes

## :tada: 3.0.0 :tada:

### Additions and Enhancements

- Retry support added for failed jobs!  Pretty much the #1 feature request of all time.
- Retry delay and backoff options added!  Expired and failed jobs can now delay a retry by a fixed time, or even a jittered exponential backoff.
  - New publish options: `retryDelay` (int) and `retryBackoff` (bool)
  - `retryBackoff` will use an exponential backoff algorithm with jitter to somewhat randomize the distribution. Inspired by Marc on the AWS blog post [Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- Backpressure support added to `subscribe()`! If your callback returns a promise, it will defer polling and other callbacks until it resolves.
  - Returning a value in your promise replaces the need to use the job.done() callback, as this will be handled automatically. Any errors thrown will also automatically fail the job.
  - A new option `teamConcurrency` was added that can be used along with `teamSize` for single job callbacks to control backpressure if a promise is returned. 
- `subscribe()` will now return an array of jobs all at once when `batchSize` is specified. When combined with your callback returning a promise once all jobs are completed, this should reduce the polling load on your database.
- `fetch()` now returns jobs with a convenience `job.done()` function like `subscribe()`
- Reduced polling load by consolidating all state-based completion subscriptions to `onComplete()`
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
- Removed `onFail()`, `offFail()`, `onExpire()`, `onExpire()`, `fetchFailed()` and `fetchExpired()`.  All job completion subscriptions should now use `onComplete()`. Jobs returned will have `request`, `response`, and `state` properties on `data`.  `state` will indicate how the job completed: `'failed'`, `'expired'` or `'completed'`.
- `startIn` option has been renamed to `startAfter` to make its behavior more clear.  Previously, this value accepted an integer for the number of seconds of delay, or a PostgreSQL interval string.  The interval string has been replaced with an UTC ISO date time string (must end in Z), or you can pass a Date object.
- `singletonDays` option has been removed

### Other items of interest
- The pgcrypto extension is now used internally for uuid generation with onComplete().  It will be added in the database if it's not already added.
- Switched jsonb type in job table to json
- Adjusted indexes to help with fetch performance

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
