# Warning table

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

To enable automatic cleanup, set the `warningRetentionDays` option:

```js
const boss = new PgBoss({
  connectionString: 'postgres://...',
  persistWarnings: true,
  warningRetentionDays: 30
});
```

Warnings are pruned during the regular maintenance cycle (controlled by `maintenanceIntervalSeconds`).

For manual cleanup:

```sql
DELETE FROM pgboss.warning WHERE created_on < now() - interval '30 days';
```
