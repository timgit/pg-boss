1. Replace index semantics for throttling and singleton

```sql
  -- anything with singletonKey means "only 1 job can be queued or active at a time"
  -- this doesn't seem very useful, since you lose the ability to queue a job that needs to be run later NUKE
    CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey)
    WHERE state < '${states.completed}' 
      AND singletonOn IS NULL 
      AND NOT singletonKey LIKE '${SINGLETON_QUEUE_KEY_ESCAPED}%'

  -- "singleton queue" means "only 1 job can be queued at a time"
  -- this seems more like what people want when they think "one job at a time"
    CREATE UNIQUE INDEX job_singleton_queue ON ${schema}.job (name, singletonKey)
    WHERE state < '${states.active}'
      AND singletonOn IS NULL
      AND singletonKey LIKE '${SINGLETON_QUEUE_KEY_ESCAPED}%'

  -- anything with singletonOn means "only 1 job within this time period, queued, active or completed"
  -- Keeping completed jobs and preventing queueing a new one until after the maintenance runs?   Doesn't seem very helpful
  -- this is only for job creation throttling, so we probably need to keep it
    CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn)
    WHERE state < '${states.expired}'
      AND singletonKey IS NULL

  -- anything with both singletonOn and singletonKey means "only 1 job within this time period with this key, queued, active or completed"
  -- Same as previous, but scoped to a filter key
    CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey)
    WHERE state < '${states.expired}'

```
  
2. Should we implement message group ids like SQS? This would require a new tracking table for in-flight groups and opt-in filtering

3. consolidate failed states: expired => failed

4. Introduce dead letter queue config
   * Removes completion jobs and onComplete config
   * Allows retries in dlq, since they become just like any other queue

5. Add primary key to archive
   * allows replication of database for read-replica and/or HA use cases
   * Existing archive table will be renamed to archive_backup and kept until the next release of pgboss

6. Allow instances to connect without trying to migrate to latest version (instances that should be able to process jobs, but not have access to schema changes or upgrades)

7. Add peek API for running TOP N queries against job tables

8. Add manual maintenance API for one-off upgrade API without processing queues
