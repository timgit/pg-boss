# Job table

Outside Node.js, from other clients or from triggers inside PostgreSQL itself, you can do most things by working directly against the internal tables. For example, to load many jobs at once without calling `send()` or `insert()`, use SQL `INSERT` or `COPY` commands.

This is the definition of the primary job table. To create a job by hand, you only need to set `name`, because every other column is nullable or has a default.

```sql
CREATE TABLE pgboss.job (
  id uuid not null default gen_random_uuid(),
  name text not null,
  priority integer not null default(0),
  data jsonb,
  state pgboss.job_state not null default 'created',
  retry_limit integer not null default 2,
  retry_count integer not null default 0,
  retry_delay integer not null default 0,
  retry_backoff boolean not null default false,
  retry_delay_max integer,
  expire_seconds int not null default 900,
  deletion_seconds int not null default 604800,
  singleton_key text,
  singleton_on timestamp without time zone,
  group_id text,
  group_tier text,
  start_after timestamp with time zone not null default now(),
  created_on timestamp with time zone not null default now(),
  started_on timestamp with time zone,
  completed_on timestamp with time zone,
  keep_until timestamp with time zone NOT NULL default now() + interval '1209600',
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
  source_output jsonb,
  source_root_id uuid,
  trace_context jsonb,
  upsert_by_key bool
) PARTITION BY LIST (name);

ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id);
```
