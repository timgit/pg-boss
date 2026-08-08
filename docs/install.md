# Database install

bun-boss will automatically create a dedicated schema (`pgboss` is the default name) in the target database. This will require the user in database connection to have the [CREATE](http://www.postgresql.org/docs/current/static/sql-grant.html) privilege.

```sql
GRANT CREATE ON DATABASE db1 TO leastprivuser;
```

If the CREATE privilege is not available or desired, export the schema DDL programmatically with the included [`getConstructionPlans()`](./api/utils.md) utility. It returns the SQL for the current schema version without executing it, so a DBA can review and run the commands manually:

```js
import { getConstructionPlans } from 'bun-boss'
import fs from 'node:fs'

fs.writeFileSync('create-bunboss.sql', getConstructionPlans('pgboss'))
```

Once the schema exists, construct the instance with `migrate: false` so `start()` verifies the schema instead of trying to create it.

> [!NOTE]
> When managing schema manually, you will need to monitor future releases for schema changes.

> [!WARNING]
> Using an existing schema is supported for advanced use cases **but discouraged**, as this opens up the possibility that creation will fail on an object name collision, and it will add more steps to the uninstallation process.

# Database uninstall

If you need to uninstall bun-boss from a database, just run the following command.

```sql
DROP SCHEMA $1 CASCADE
```

Where `$1` is the name of your schema if you've customized it.  Otherwise, the default schema is `pgboss`.

NOTE: If an existing schema was used during installation, created objects will need to be removed manually using the following commands.

```sql
DROP TABLE pgboss.version;
DROP TABLE pgboss.job;
DROP TYPE pgboss.job_state;
DROP TABLE pgboss.schedule;
DROP FUNCTION pgboss.create_queue;
DROP FUNCTION pgboss.delete_queue;
DROP TABLE pgboss.queue;
```
