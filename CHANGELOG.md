# Changes

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
