# Utility functions

The following static functions are not required during normal operations, but are intended to assist in schema creation or migration if run-time privileges do not allow schema changes.

### `getConstructionPlans(schema)`

**Arguments**
- `schema`: string, database schema name

Returns the SQL commands required for manual creation of the required schema.

### `getMigrationPlans(schema, version)`

**Arguments**
- `schema`: string, database schema name
- `version`: string, target schema version to migrate

Returns the SQL commands required to manually migrate from the specified version to the latest version.

### `getRollbackPlans(schema, version)`

**Arguments**
- `schema`: string, database schema name
- `version`: string, target schema version to uninstall

Returns the SQL commands required to manually roll back the specified version to the previous version
