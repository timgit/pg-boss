v10 is the largest semver major release of pg-boss in years. The API changes included below are ordered by significance.

## Database changes
PostgreSQL 12 is now the minimum supported version. If you upgrade and run `start()`, the database will automatically be upgraded. However, this release requires rebuilding almost all of the job table indexes, which may require a bit of downtime depending on the size of your queues. If this is a concern, you may extract the migration script via `getMigrationPlans()` and run it against a backup to get an estimate on downtime.

If the standard auto-migration isn't desired, consider alternatives, such as running a new v10 schema side by side of a v9 schema until the v9 queues are drained. 

## API changes

* MAJOR: **Job retries are now opt-out instead of opt-in.** The default `retryLimit` is now 2 retries. This will cause an issue for any job handlers that aren't idempotent. Consider setting `retryLimit=0` on these queues if needed.

* MAJOR: **Policy queues.** Queues can now be optionally created using `createQueue()` with a new set of storage policies. Each policy will store jobs in dedicated partition tables (courtesy of Postgres's declarative partitioning). Additionally, these queues can store default retry and retention policies that will be auto-applied to all new jobs (see below).
  
  * **`standard`** (default): Standard queues are the default queue policy, which supports all existing features. This will provision a dedicated job partition for all jobs with this name.
  * **`short`**: Short queues only allow 1 item to be queued (in created state), which replaces the previous `sendSingleton()` and `sendOnce()` functions. 
  * **`singleton`**: Singleton queues only allow 1 item to be active, which replaces the previous `fetch()` option `enforceSingletonQueueActiveLimit`. 
  * **`stately`**: Stately queues are a combination of `short` and `singleton`, only allowing 1 job to be queued and 1 job active.

* MAJOR: **Dead letter queues replace completion jobs.** Failed jobs will be added to optional dead letter queues after exhausting all retries. This is preferred over completion jobs to gain retry support via `work()`. Additionally, dead letter queues  only make a copy of the job if it fails, instead of filling up the job table with numerous, mostly unneeded completion jobs.
   * `onComplete` option in `send()` and `insert()` has been removed
   * `onComplete()`, `offComplete()`, and `fetchCompleted()` have been removed
   * `deadLetter` option added to `send()` and `insert()` and `createQueue()`

* MAJOR: Dropped the following API functions in favor of policy queues
  * `sendOnce()`
  * `sendSingleton()`

* MAJOR: Postgres 12 is now the minimum required version
* MAJOR: Node 18 is now the minimum required version

* MINOR: `send()` and `insert()` cascade configuration from policy queues (if they exist) and then global settings in the constructor. Use the following table to help identify which settings are inherited and when.
  
  | Setting | API | Queue | Constructor |
  | - | - | - | - |
  | `retryLimit` | * | - [x] | - [x] |
  | `retryDelay` | * | - [x] | - [x] |
  | `retryBackoff` | * | - [x] | - [x] |
  | `expireInSeconds` | * | - [x] | - [x] |
  | `expireInMinutes` | `send()`, `createQueue()` | - [x] | - [x] |
  | `expireInHours`   | `send()`, `createQueue()` | - [x] | - [x] |
  | `retentionSeconds` | `send()`, `createQueue()` | - [x] | - [x] |
  | `retentionMinutes` | `send()`, `createQueue()` | - [x] | - [x] |
  | `retentionHours` | `send()`, `createQueue()` | - [x] | - [x] |
  | `retentionDays` | `send()`, `createQueue()` | - [x] | - [x] |
  | `deadLetter` | * | - [x] | - [ ] |

* MINOR: Added primary key to job archive to support replication use cases such as read replicas or high availability standbys.
   * Existing archive table will be renamed to archive_backup and kept until the next release of pgboss, at which event it will be removed. This is only to make sure the automatic schema migration is fast. If you no longer need the jobs in archive and it's blocking you from replication, you can run the following to drop it.
    
      ```sql
      DROP TABLE archive_backup
      ```

* MINOR: Added a new constructor option, `migrate:false`, to block an instance from attempting to migrate to the latest database schema version. This is useful if the configured credentials don't have schema modification privileges or complete control of when and how migrations are run is required.
   
* MINOR: `noSupervisor` and `noScheduling` were renamed to a more intuitive naming convention. 
  * If using `noSupervisor: true` to disable mainteance, instead use `supervise: false`
  * If using `noScheduling: true` to disable scheduled cron jobs, use `schedule: false`

* MINOR: The `expired` failed state has been consolidated into `failed` for simplicity.

* MINOR: Added `priority:false` option to `work()` and `fetch()` to opt out of priority sorting during job fetching. If a queue is very large and not using the priority feature, this may help job fetch performance.

* MINOR: Added a manual maintenance API if desired: `maintain()`.

* MINOR: `stop()` will now wait for the default graceful stop timeout (30s) before resolving its promise. The `stopped` event will still emit. If you want to the original behavior, set the new  `wait` option to `false`.

* MINOR: Added `id` property as an option to `send()` for pre-assigning the job id. Previously, only `insert()` supported pre-assignment.