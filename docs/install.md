# Database install <!-- {docsify-ignore-all} -->

pg-boss will automatically create a dedicated schema (`pgboss` is the default name) in the target database. This will require the user in database connection to have the [CREATE](http://www.postgresql.org/docs/current/static/sql-grant.html) privilege.

```sql
GRANT CREATE ON DATABASE db1 TO leastprivuser;
```

If the CREATE privilege is not available or desired, you have two options:

1. **CLI (recommended)** - Use the pg-boss CLI to manage schema creation and migrations. The CLI can output SQL without executing it (`--dry-run` or `plans` command), allowing DBAs to review and run the commands manually. See the [CLI documentation](https://github.com/timgit/pg-boss#cli) for details.

2. **Static functions** - Use the included [utility functions](./api/utils) to export the SQL commands programmatically.

**Note:** When managing schema manually, you will need to monitor future releases for schema changes.

NOTE: Using an existing schema is supported for advanced use cases **but discouraged**, as this opens up the possibility that creation will fail on an object name collision, and it will add more steps to the uninstallation process.

# Database uninstall

If you need to uninstall pg-boss from a database, just run the following command.

```sql
DROP SCHEMA $1 CASCADE
```

Where `$1` is the name of your schema if you've customized it.  Otherwise, the default schema is `pgboss`.

NOTE: If an existing schema was used during installation, created objects will need to be removed manually using the following commands.

```sql
DROP TABLE pgboss.version;
DROP TABLE pgboss.job;
DROP TYPE pgboss.job_state;
DROP TABLE pgboss.subscription;
DROP TABLE pgboss.schedule;
DROP FUNCTION pgboss.create_queue;
DROP FUNCTION pgboss.delete_queue;
DROP TABLE pgboss.queue;
```