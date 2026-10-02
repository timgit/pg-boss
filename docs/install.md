# Database install

pg-boss will automatically create a dedicated schema (`pgboss` is the default name) in the target database. This will require the user in database connection to have the [CREATE](http://www.postgresql.org/docs/current/static/sql-grant.html) privilege.

```sql
GRANT CREATE ON DATABASE db1 TO leastprivuser;
```

If the CREATE privilege is not available or desired, you have two options:

1. **CLI (recommended)** - Use the pg-boss CLI to manage schema creation and migrations. The CLI can output SQL without executing it (`--dry-run` or `plans` command), allowing DBAs to review and run the commands manually. See the [CLI documentation](./cli) for details.

2. **Static functions** - Use the included [utility functions](./api/utils) to export the SQL commands programmatically.

> [!NOTE]
> When managing schema manually, you will need to monitor future releases for schema changes.

> [!WARNING]
> Using an existing schema is supported for advanced use cases **but discouraged**, as this opens up the possibility that creation will fail on an object name collision, and it will add more steps to the uninstallation process.

# Database uninstall

To remove pg-boss from a database, drop its schema:

```sql
DROP SCHEMA pgboss CASCADE
```

Use your schema's name in place of `pgboss` if you set one.

If pg-boss was installed into an existing schema that also holds other objects, dropping the schema would remove those too. Drop only pg-boss's own objects instead, with the SQL from [`pg-boss plans uninstall --schema <name>`](./cli#plans) or [`getUninstallPlans()`](./api/utils#getuninstallplans-schema-options).
