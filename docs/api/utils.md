# Utility functions

The following function is exported from the package and is not required during normal operations, but is intended to assist in schema creation if run-time privileges do not allow schema changes.

```js
import { getConstructionPlans } from 'bun-boss'
```

### `getConstructionPlans(schema)`

**Arguments**
- `schema`: string, database schema name

Returns the SQL commands required for manual creation of the required schema.

```js
const sql = getConstructionPlans('pgboss')

// hand the DDL to a migration tool or a privileged operator
fs.writeFileSync('create-bunboss.sql', sql)
```
