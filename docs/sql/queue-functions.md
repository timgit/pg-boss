# Queue functions

Queues can be created or deleted from SQL functions. These functions exist on the Postgres and PGlite backends only — SQLite has no stored functions, so `createQueue()` and `deleteQueue()` issue plain statements there instead.

Calling them directly bypasses the JavaScript layer, which is where the defaulting, validation, and queue-cache bookkeeping live. In particular, a running instance is not notified: a queue deleted with `pgboss.delete_queue()` may stay in that instance's queue cache until it restarts. A queue created in SQL is picked up, because a cache miss falls through to the database.

### `pgboss.create_queue(queue_name text, options jsonb)`

Options are the same as in [`createQueue()`](../api/queues.md#createqueuename-options), with one difference: `policy` has no default here and must always be supplied. `createQueue()` defaults it to `standard` in JavaScript, so omitting it in SQL raises a not-null violation (`23502`) on `queue.policy`.

The recognized option keys are `policy`, `retryLimit`, `retryDelay`, `retryBackoff`, `retryDelayMax`, `expireInSeconds`, `retentionSeconds`, `deleteAfterSeconds`, `warningQueueSize`, `deadLetter`, `partition`, `heartbeatSeconds`, and `notify`. The queue name is the separate first argument.

Unlike `createQueue()`, this function performs no validation: an unrecognized `policy` is stored as-is, unknown option keys are silently ignored, and a `deadLetter` naming a queue that does not exist fails with a raw foreign key error (`23503`).

### `pgboss.delete_queue(queue_name text)`

Deletes a queue, all its jobs, and any schedules attached to it. If the queue was created with `partition: true`, its dedicated partition table is dropped rather than emptied.

The queue must exist. Unlike `deleteQueue()`, which is a deliberate no-op for an unknown queue, calling this on a missing queue raises `null values cannot be formatted as an SQL identifier` (`22004`).

### `pgboss.job_table_run(command text, tbl_name text, queue_name text)`

Applies a DDL command across the job tables. Both `tbl_name` and `queue_name` default to `NULL`: pass `queue_name` to target that queue's table, `tbl_name` to target a table by name, or neither to apply the command to the common job table and to every queue created with `partition: true`.

Write the command against `pgboss.job` and the bare index names (`job_i1`, `job_i2`, and so on); `pgboss.job_table_format(command text, table_name text)` is the helper that rewrites those identifiers for each target table.
