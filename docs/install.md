# Database install

bun-boss will automatically create a dedicated schema (`pgboss` is the default name) in the target database. This will require the user in database connection to have the [CREATE](https://www.postgresql.org/docs/current/sql-grant.html) privilege.

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

The runtime user still needs access to the objects the DBA created, otherwise `start()` fails with `permission denied for schema pgboss`. Grant it usage on the schema and DML on its tables:

```sql
GRANT USAGE ON SCHEMA pgboss TO leastprivuser;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO leastprivuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO leastprivuser;
```

`ON ALL TABLES` only covers the tables that exist when you run it, so the `ALTER DEFAULT PRIVILEGES` line is what keeps a queue created later reachable.

No CREATE privilege is required at runtime with `migrate: false`, as long as queues are created by the privileged operator. Creating a queue from the application still performs DDL: `createQueue(name, { partition: true })` builds a dedicated table and fails with `permission denied for schema pgboss`, and deleting a partitioned queue requires ownership of that table.

> [!NOTE]
> When managing schema manually, you will need to monitor future releases for schema changes.

> [!WARNING]
> Using an existing schema is supported for advanced use cases **but discouraged**, as this opens up the possibility that creation will fail on an object name collision, and it will add more steps to the uninstallation process.

# Database uninstall

If you need to uninstall bun-boss from a database, just run the following command.

```sql
DROP SCHEMA pgboss CASCADE
```

Replace `pgboss` with the name of your schema if you've customized it. The schema name cannot be supplied as a bind parameter — it must be written into the statement.

NOTE: If an existing schema was used during installation, created objects will need to be removed manually using the following commands.

```sql
DROP TABLE pgboss.version;
DROP TABLE pgboss.job_dependency;
DROP TABLE pgboss.job_common;
DROP TABLE pgboss.job;
DROP TYPE pgboss.job_state;
DROP TABLE pgboss.schedule;
DROP FUNCTION pgboss.create_queue;
DROP FUNCTION pgboss.delete_queue;
DROP FUNCTION pgboss.job_table_format;
DROP FUNCTION pgboss.job_table_run;
DROP TABLE pgboss.queue;
```
