# Utility functions

The package exports these functions, and normal operation doesn't need any of them. The plan functions help you create or migrate the schema when pg-boss's run-time privileges don't allow schema changes. [`percentile()`](#percentile-bins-p) and [`addBins()`](#addbins-a-b) read the wait and run [latency histograms](./queues.md#getqueues-names-options).

```js
import { getConstructionPlans, getMigrationPlans, getRollbackPlans, getUninstallPlans, getIndexBloatPlans } from 'pg-boss'
```

The plan functions take an optional `backend`, which names the engine the SQL will run against. It's the same profile the [constructor](../database-backends.md) takes, and the same one [`pg-boss migrate --backend`](../cli.md#backends) takes. Without it, the plans are stock PostgreSQL, which a distributed engine rejects partway through because of table partitioning, advisory locks, covering indexes, and a column written in the transaction that added it. `postgres` is the default, and `pglite` needs nothing here since it's stock PostgreSQL.

### `getConstructionPlans(schema, options)`

**Arguments**
- `schema`: string, database schema name
- `options`: object, optional. Accepts `createSchema` (default `true`) and `backend`.

Returns the SQL commands that create the schema, for you to run by hand.

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

Returns the SQL commands that migrate the schema from the given version to the latest version, for you to run by hand.

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

Returns the SQL commands that roll the given version back to the previous version, for you to run by hand.

```js
const sql = getRollbackPlans('pgboss', 36)
```

### `getUninstallPlans(schema, options)`

**Arguments**
- `schema`: string, database schema name
- `options`: object, optional. Accepts `backend`.

Returns the SQL that removes every table, function and type pg-boss installs in the schema. Use it when pg-boss shares the schema with other objects. A queue's own table goes with the job table. If pg-boss has the schema to itself, `DROP SCHEMA <name> CASCADE` does the same.

```js
const sql = getUninstallPlans('myapp')
```

### `getIndexBloatPlans(schema, options)`

**Arguments**
- `schema`: string, database schema name
- `options`: object, optional. Accepts `minPages` (default 128), `maxEntriesPerPage` (default 5) and `minSizeRatio` (default 4).

Returns the catalog query pg-boss uses to find bloated job indexes, as SQL text. It's PostgreSQL only, since CockroachDB doesn't answer it. Unlike [`getReindexCommands()`](./ops.md#getreindexcommands-options), it needs no instance and no connection from this process. Paste it into psql or hand it to a monitoring tool.

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

### `percentile(bins, p)`

**Arguments**
- `bins`: a [latency histogram](./queues.md#getqueues-names-options), `waitBins` or `runBins`, or several added with [`addBins()`](#addbins-a-b)
- `p`: percent from 1 to 100, such as `95` for the 95th percentile

Returns the time in seconds below which that fraction of the histogram's jobs fall, or `null` for an empty or missing histogram. The result is an estimate. It always falls in the same bin as the exact value, and with a few thousand jobs it's typically within a few percent of it. A percentile under 10 ms reads as `0.01`.

```js
import { percentile } from 'pg-boss'

const [stats] = await boss.getQueueStats('email-send')
const p95 = percentile(stats.waitBins, 95)
```

### `addBins(a, b)`

**Arguments**
- `a`, `b`: [latency histograms](./queues.md#getqueues-names-options), or `null`

Combines two histograms into one by adding their counts bin by bin, as if every job in both had been recorded together. Use it to merge snapshots over a time range, or several queues, before reading a percentile with [`percentile()`](#percentile-bins-p), because averaging percentiles taken from smaller spans doesn't give a percentile.

```js
addBins([0, 2, 5, 1, …], [1, 0, 3, 4, …]) // [1, 2, 8, 5, …]
```

It returns a new array and leaves both arguments unchanged. A `null` argument counts as an empty histogram, so `null` is a safe starting value when combining a list, and the result is `null` only when both are.

```js
import { addBins, percentile } from 'pg-boss'

// the p95 wait over the last hour, from the snapshots in it
const hour = await boss.getQueueStats('email-send', { from: new Date(Date.now() - 3600_000) })
const waits = hour.reduce((sum, s) => addBins(sum, s.waitBins), null)

console.log(`p95 wait ${percentile(waits, 95)?.toFixed(1)} s`)
```
