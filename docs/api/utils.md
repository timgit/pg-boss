# Utility functions

The following functions are exported from the package and are not required during normal operations, but are intended to assist in schema creation or migration if run-time privileges do not allow schema changes.

```js
import { getConstructionPlans, getMigrationPlans, getRollbackPlans, getIndexBloatPlans } from 'pg-boss'
```

All three plan functions take an optional `backend`, which names the engine the SQL is meant to run against. It is the same profile the [constructor](../database-backends.md) takes, and the same one [`pg-boss migrate --backend`](../cli.md#backends) takes. Without it plans are stock PostgreSQL, which a distributed engine rejects partway through: table partitioning, advisory locks, covering indexes, a column written in the transaction that added it. `postgres` is the default, and `pglite` needs nothing here since it is stock PostgreSQL.

### `getConstructionPlans(schema, options)`

**Arguments**
- `schema`: string, database schema name
- `options`: object, optional. Accepts `createSchema` (default `true`) and `backend`.

Returns the SQL commands required for manual creation of the required schema.

```js
const sql = getConstructionPlans('pgboss')

// hand the DDL to a migration tool or a privileged operator
fs.writeFileSync('create-pgboss.sql', sql)

// the same schema, as CockroachDB accepts it
const crdb = getConstructionPlans('pgboss', { backend: 'cockroachdb' })
```

### `getMigrationPlans(schema, version, options)`

**Arguments**
- `schema`: string, database schema name
- `version`: int, current schema version to migrate from
- `options`: object, optional. Accepts `partitionTables` and `backend`.

Returns the SQL commands required to manually migrate from the specified version to the latest version.

```js
// generate the SQL to upgrade an installation on schema version 35 to the latest
// (use schemaVersion() on a running instance to look up the current version)
const sql = getMigrationPlans('pgboss', 35)
```

### `getRollbackPlans(schema, version, options)`

**Arguments**
- `schema`: string, database schema name
- `version`: int, target schema version to uninstall
- `options`: object, optional. Accepts `backend`.

Returns the SQL commands required to manually roll back the specified version to the previous version

```js
const sql = getRollbackPlans('pgboss', 36)
```

### `getIndexBloatPlans(schema, options)`

**Arguments**
- `schema`: string, database schema name
- `options`: object, optional. Accepts `minPages` (default 128), `maxEntriesPerPage` (default 5) and `minSizeRatio` (default 4).

Returns the catalog query pg-boss uses to find bloated job indexes, as SQL text. PostgreSQL only, since CockroachDB and YugabyteDB do not answer it. Unlike [`getReindexCommands()`](./ops.md#getreindexcommands-options) this needs no instance and no connection from this process. It is meant to be pasted into psql or handed to a monitoring tool.

```js
const sql = getIndexBloatPlans('pgboss')
```

Each row describes one index that is holding far more pages than its live entries need:

| Column | Description |
| --- | --- |
| `name` | Index name |
| `table` | The job table it belongs to |
| `pages` | Size in 8 kB pages |
| `entries` | Live entries, as of the last `VACUUM` / `ANALYZE` |
| `bytes` | Size on disk |
| `owned` | Whether the connected role can `REINDEX` it |

`pages` and `entries` come from `pg_class`, which only `VACUUM` and `ANALYZE` refresh, so the results go stale on a table with autovacuum disabled.
