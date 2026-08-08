# Job table

If you need to interact with bun-boss outside of Bun, such as other clients or even using triggers within PostgreSQL itself, most functionality is supported when working directly against the internal tables. For example, if you wanted to bulk load jobs and skip calling `send()` or `insert()`, you could use SQL `INSERT` or `COPY` commands.

The following is the primary job table on the Postgres and PGlite backends. The SQLite backend installs an equivalent table in its own dialect (text timestamps, integer booleans, no partitioning). For manual job creation, the only required column is `name`. All other columns are nullable or have defaults.

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
