# CLI

pg-boss includes a command-line interface for managing database migrations without writing code. This is useful for CI/CD pipelines, database setup scripts, or manual schema management.

## Installation

When installed globally, the CLI is available as `pg-boss`:

```bash
npm install -g pg-boss
pg-boss --help
```

Or run directly with npx:

```bash
npx pg-boss --help
```

## Commands

| Command | Description |
|---------|-------------|
| `migrate` | Run pending migrations (creates schema if not exists) |
| `create` | Create initial pg-boss schema |
| `version` | Show current schema version |
| `rollback` | Rollback the last migration |
| `plans <subcommand>` | Output SQL without executing (subcommands: `create`, `migrate`, `rollback`) |

## Connection Configuration

The CLI supports multiple ways to configure the database connection, in order of precedence:

1. **Command-line arguments**
   ```bash
   pg-boss migrate --connection-string postgres://user:pass@host/database
   # or individual options
   pg-boss migrate --host localhost --port 5432 --database mydb --user postgres --password secret
   ```

2. **Environment variables**
   ```bash
   PGBOSS_DATABASE_URL=postgres://user:pass@host/database pg-boss migrate
   # or individual variables
   PGBOSS_HOST=localhost PGBOSS_PORT=5432 PGBOSS_DATABASE=mydb PGBOSS_USER=postgres PGBOSS_PASSWORD=secret pg-boss migrate
   ```

   This allows admin credentials for migrations to coexist with regular application database credentials (e.g., `DATABASE_URL` for the app, `PGBOSS_DATABASE_URL` for migrations).

3. **Config file** (pgboss.json or .pgbossrc in current directory, or specify with `--config`)
   ```bash
   pg-boss migrate --config ./config/pgboss.json
   ```

   Config file format:
   ```json
   {
     "host": "localhost",
     "port": 5432,
     "database": "mydb",
     "user": "postgres",
     "password": "secret",
     "schema": "pgboss"
   }
   ```

## Options

| Option | Short | Description |
|--------|-------|-------------|
| `--connection-string` | `-c` | PostgreSQL connection string |
| `--host` | | Database host |
| `--port` | | Database port |
| `--database` | `-d` | Database name |
| `--user` | `-u` | Database user |
| `--password` | `-p` | Database password |
| `--schema` | `-s` | pg-boss schema name (default: pgboss) |
| `--config` | | Path to config file |
| `--dry-run` | | Show SQL without executing (for migrate, create, rollback) |

## Examples

```bash
# Create schema in a new database
pg-boss create --connection-string postgres://localhost/myapp

# Run migrations in CI/CD pipeline
PGBOSS_DATABASE_URL=$PGBOSS_DATABASE_URL pg-boss migrate

# Preview migration SQL before running
pg-boss migrate --connection-string postgres://localhost/myapp --dry-run

# Check current schema version
pg-boss version -c postgres://localhost/myapp

# Use a custom schema name
pg-boss migrate -c postgres://localhost/myapp --schema myapp_jobs

# Output SQL for creating schema (useful for review or manual execution)
pg-boss plans create --schema myapp_jobs
```
