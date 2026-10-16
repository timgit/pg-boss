# Warning table

When you enable `persistWarnings` in the constructor options, pg-boss stores its warnings in this table. That keeps a history you can query, and the [pg-boss dashboard](https://www.npmjs.com/package/@pg-boss/dashboard) shows it.

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
| `type` | Warning type, as listed with the [`warning` event](../api/events.md#warning) |
| `message` | Human-readable warning message |
| `data` | JSON object with warning-specific details |
| `created_on` | Timestamp when the warning was recorded |

## Querying

```sql
-- Recent warnings
SELECT * FROM pgboss.warning ORDER BY created_on DESC LIMIT 100;

-- Warnings by type
SELECT * FROM pgboss.warning WHERE type = 'queue_backlog' ORDER BY created_on DESC;

-- Warnings from the last hour
SELECT * FROM pgboss.warning WHERE created_on > now() - interval '1 hour';
```

## Cleanup

pg-boss deletes warnings older than 365 days. To keep them for less time, set the `warningRetentionDays` option:

```js
const boss = new PgBoss({
  connectionString: 'postgres://...',
  persistWarnings: true,
  warningRetentionDays: 30
});
```

Maintenance prunes them on its regular cycle, which `maintenanceIntervalSeconds` sets.

For manual cleanup:

```sql
DELETE FROM pgboss.warning WHERE created_on < now() - interval '30 days';
```
