# Database install

pg-boss creates its own schema in the target database (`pgboss` by default). The database user it connects as needs the [CREATE](http://www.postgresql.org/docs/current/static/sql-grant.html) privilege.

```sql
GRANT CREATE ON DATABASE db1 TO leastprivuser;
```

If you can't or don't want to grant CREATE, you have two options:

1. **CLI (recommended).** Use the pg-boss CLI to create the schema and run migrations. The CLI can print the SQL without running it (`--dry-run` or the `plans` command), so a DBA can review the commands and run them by hand. See the [CLI documentation](./cli) for details.

2. **Static functions.** Use the included [utility functions](./api/utils) to get the SQL commands from code.

> [!NOTE]
> If you manage the schema by hand, watch future releases for schema changes.

> [!WARNING]
> pg-boss supports installing into an existing schema for advanced use cases, **but it's discouraged**. Creation can fail on an object name collision, and uninstalling takes more steps.

# Database uninstall

To remove pg-boss from a database, drop its schema:

```sql
DROP SCHEMA pgboss CASCADE
```

Use your schema's name in place of `pgboss` if you set one.

If pg-boss was installed into an existing schema that also holds other objects, dropping the schema would remove those too. Drop only pg-boss's own objects instead, with the SQL from [`pg-boss plans uninstall --schema <name>`](./cli#plans) or [`getUninstallPlans()`](./api/utils#getuninstallplans-schema-options).
