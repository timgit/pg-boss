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
  expire_seconds integer not null default (900),
  deletion_seconds integer not null default (60 * 60 * 24 * 7),
  singleton_key text,
  singleton_on timestamp without time zone,
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
  CONSTRAINT job_pkey PRIMARY KEY (name, id)
) PARTITION BY LIST (name)
```

## Queue functions

Queues can be created or deleted from SQL functions.

`pgboss.create_queue(queue_name text, options jsonb)`

options: Same as options in [`createQueue()`](./api/queues?id=createqueuename-queue)

`pgboss.delete_queue(queue_name text)`

## Warning table

When `persistWarnings` is enabled in the constructor options, warnings are stored in this table. This enables historical tracking and can be used with the [pg-boss dashboard](https://www.npmjs.com/package/@pg-boss/dashboard) for monitoring.

```sql
CREATE TABLE pgboss.warning (
  id serial PRIMARY KEY,
  type text NOT NULL,
  message text NOT NULL,
  data jsonb,
  created_on timestamp with time zone NOT NULL DEFAULT now()
)
```

| Column | Description |
|--------|-------------|
| `id` | Auto-incrementing primary key |
| `type` | Warning type: `slow_query`, `queue_backlog`, or `clock_skew` |
| `message` | Human-readable warning message |
| `data` | JSON object with warning-specific details |
| `created_on` | Timestamp when the warning was recorded |

### Querying warnings

```sql
-- Recent warnings
SELECT * FROM pgboss.warning ORDER BY created_on DESC LIMIT 100;

-- Warnings by type
SELECT * FROM pgboss.warning WHERE type = 'queue_backlog' ORDER BY created_on DESC;

-- Warnings from the last hour
SELECT * FROM pgboss.warning WHERE created_on > now() - interval '1 hour';
```

### Cleanup

To enable automatic cleanup of old warnings, set the `warningRetentionDays` option:

```js
const boss = new PgBoss({
  connectionString: 'postgres://...',
  persistWarnings: true,
  warningRetentionDays: 30  // Delete warnings older than 30 days
});
```

Warnings are pruned during the regular maintenance cycle (controlled by `maintenanceIntervalSeconds`).

For manual cleanup:

```sql
DELETE FROM pgboss.warning WHERE created_on < now() - interval '30 days';
```