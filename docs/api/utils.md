# Utility functions

The following functions are exported from the package and are not required during normal operations, but are intended to assist in schema creation or migration if run-time privileges do not allow schema changes.

```js
import { getConstructionPlans, getMigrationPlans, getRollbackPlans } from 'pg-boss'
```

### `getConstructionPlans(schema)`

**Arguments**
- `schema`: string, database schema name

Returns the SQL commands required for manual creation of the required schema.

```js
const sql = getConstructionPlans('pgboss')

// hand the DDL to a migration tool or a privileged operator
fs.writeFileSync('create-pgboss.sql', sql)
```

### `getMigrationPlans(schema, version)`

**Arguments**
- `schema`: string, database schema name
- `version`: int, current schema version to migrate from

Returns the SQL commands required to manually migrate from the specified version to the latest version.

```js
// generate the SQL to upgrade an installation on schema version 35 to the latest
// (use schemaVersion() on a running instance to look up the current version)
const sql = getMigrationPlans('pgboss', 35)
```

### `getRollbackPlans(schema, version)`

**Arguments**
- `schema`: string, database schema name
- `version`: int, target schema version to uninstall

Returns the SQL commands required to manually roll back the specified version to the previous version

```js
const sql = getRollbackPlans('pgboss', 36)
```
