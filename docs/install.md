# Database install

The first time [`start()`](./api/ops#start) runs, pg-boss creates its own schema (`pgboss` by default) in the target database, so there is no separate install step. When you upgrade pg-boss, `start()` migrates the schema the same way.

That needs the database user pg-boss connects as to have the [CREATE](http://www.postgresql.org/docs/current/static/sql-grant.html) privilege on the database:

```sql
GRANT CREATE ON DATABASE db1 TO leastprivuser;
```

Only if that privilege isn't available or wanted do you need to manage the schema yourself, as a fallback, in one of two ways:

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

If pg-boss was installed into an existing schema that also holds other objects, dropping the schema would remove those too. Drop pg-boss's own objects instead: the output of `pg-boss plans create --schema <name>` (see the [CLI](./cli#plans)) lists everything it installs.
