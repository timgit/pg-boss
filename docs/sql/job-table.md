# Job table

If you need to interact with bun-boss outside of Bun, such as other clients or even using triggers within PostgreSQL itself, most functionality is supported when working directly against the internal tables. For example, if you wanted to bulk load jobs and skip calling `send()` or `insert()`, you could use SQL `INSERT` or `COPY` commands.

Writing rows directly bypasses the JavaScript layer, which is where `send()` and `insert()` do their defaulting and validation, so the preconditions below become yours to satisfy.

The following is the primary job table on the Postgres and PGlite backends. The SQLite backend installs an equivalent table in its own dialect (text timestamps, text ids and json, integer booleans, a CHECK-constrained `state` column instead of an enum, and no partitioning). For manual job creation, the only required column is `name`. All other columns are nullable or have defaults.

The queue itself must already exist — `name` is a foreign key to `pgboss.queue`, so create the queue with `createQueue()` or `pgboss.create_queue()` first, otherwise the insert fails with `23503`.

Those defaults are the *table's*, not the *queue's*. `send()` and `insert()` copy `policy`, `retry_limit`, `retry_delay`, `expire_seconds` and `deletion_seconds` from the queue row and compute `keep_until` from its retention window; a hand-written `INSERT` silently gets `policy = NULL` and the hardcoded table defaults instead. Set those columns explicitly if the queue is not using the defaults — especially `policy`, since a NULL there makes the row invisible to every policy-enforcing partial index.

The `state` column is an enum whose declaration order is significant: several internal queries compare states with `<` and `>` (`state < 'active'` means queued, for example).

```sql
CREATE TYPE pgboss.job_state AS ENUM (
  'created',
  'retry',
  'active',
  'completed',
  'cancelled',
  'failed'
)
```

This is reference DDL — bun-boss creates the table itself during `start()`, so there is no need to run it yourself.

```sql
CREATE TABLE pgboss.job (
  id uuid not null default gen_random_uuid(),
  name text not null,
  priority integer not null default(0),
  data jsonb,
  state pgboss.job_state not null default('created'),
  retry_limit integer not null default(2),
  retry_count integer not null default(0),
  retry_delay integer not null default(0),
  retry_backoff boolean not null default false,
  retry_delay_max integer,
  expire_seconds integer not null default (900),
  deletion_seconds integer not null default (60 * 60 * 24 * 7),
  singleton_key text,
  singleton_on timestamp without time zone,
  group_id text,
  group_tier text,
  start_after timestamp with time zone not null default now(),
  created_on timestamp with time zone not null default now(),
  started_on timestamp with time zone,
  completed_on timestamp with time zone,
  keep_until timestamp with time zone NOT NULL default now() + interval '14 days',
  output jsonb,
  dead_letter text,
  policy text,
  heartbeat_on timestamp with time zone,
  heartbeat_seconds int,
  blocked boolean not null default false,
  blocking boolean not null default false,
  pending_dependencies int not null default 0,
  source_name text,
  source_id uuid,
  source_created_on timestamp with time zone,
  source_retry_count int,
  CONSTRAINT job_pkey PRIMARY KEY (name, id)
) PARTITION BY LIST (name)
```

### Constraints and indexes

The parent `job` table carries only `job_pkey`; the rest is installed on each partition. Every partition gets `q_fkey` (`name` referencing `pgboss.queue`) and `dlq_fkey` (`dead_letter` referencing `pgboss.queue`), both `ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`, plus eight partial indexes named after the partition (`job_common_i1` through `job_common_i7` and `job_common_i9` on the default partition) that back the queue policies, throttling, fetch, group concurrency, and flow resolution.
