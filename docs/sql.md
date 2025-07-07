# SQL

If you need to interact with pg-boss outside of Node.js, such as other clients or even using triggers within PostgreSQL itself, most functionality is supported even when working directly against the internal tables.  Additionally, you may even decide to do this within Node.js. For example, if you wanted to bulk load jobs into pg-boss and skip calling `send()` or `insert()`, you could use SQL `INSERT` or `COPY` commands.

## Job table

The following command is the definition of the primary job table. For manual job creation, the only required column is `name`.  All other columns are nullable or have defaults.

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
  retry_delay_max integer;
  start_after timestamp with time zone not null default now(),
  started_on timestamp with time zone,
  singleton_key text,
  singleton_on timestamp without time zone,
  expire_seconds integer not null default (900),
  deletion_seconds integer not null default (60 * 60 * 24 * 7),
  created_on timestamp with time zone not null default now(),
  completed_on timestamp with time zone,
  keep_until timestamp with time zone NOT NULL default now() + interval '14 days',
  output jsonb,
  dead_letter text,
  policy text,
  CONSTRAINT job_pkey PRIMARY KEY (name, id)
) PARTITION BY LIST (name)
```

## Queue functions

Queues can be created or deleted from SQL functions.

`pgboss.create_queue(queue_name text, options json)`

options: Same as options in [`createQueue()`](./api/queues?id=createqueuename-queue)

`pgboss.delete_queue(queue_name text)`