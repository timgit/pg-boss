# Utility functions

The following function is exported from the package and is not required during normal operations, but is intended to assist in schema creation if run-time privileges do not allow schema changes.

```js
import { getConstructionPlans } from 'bun-boss'
```

### `getConstructionPlans(schema?, options?)`

**Arguments**
- `schema`: string, database schema/namespace name (optional; defaults to `'pgboss'`, or `'bunboss'` in prefix mode)
- `options`: object (optional)
  - `tableIsolation`: `'schema' | 'prefix'` — match the [`tableIsolation`](../database-backends.md#table-isolation) you construct `BunBoss` with. In `'prefix'` mode the DDL creates quoted `"schema.table"` objects in the default schema, skips `CREATE SCHEMA`, and omits partitioning.

Returns the SQL commands required for manual creation of the required schema.

```js
import fs from 'node:fs'

const sql = getConstructionPlans('pgboss')

// hand the DDL to a migration tool or a privileged operator
fs.writeFileSync('create-bunboss.sql', sql)

// prefix mode, into the default schema:
const prefixed = getConstructionPlans('bunboss', { tableIsolation: 'prefix' })
```

### Constants

The package also exports frozen constants so you can reference states, policies, and event names without hardcoding strings.

```js
import { states, policies, events } from 'bun-boss'

states.completed   // 'completed'
policies.singleton // a queue policy accepted by createQueue()
events.error       // 'error'
```

`states` mirrors the job states, `policies` the queue policies accepted by `createQueue()`, and `events` the event names emitted by a `BunBoss` instance.
