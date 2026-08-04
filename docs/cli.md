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
| `doctor` | Check for schema drift (indexes, functions, enum) against the expected schema |
| `rollback` | Rollback the last migration |
| `plans <subcommand>` | Output SQL without executing (subcommands: `create` (alias `construct`), `migrate`, `rollback`; defaults to `migrate`) |

Every command reads its connection from the same sources (see [Connection Configuration](#connection-configuration)). Commands that touch the database exit `1` on error.

### `migrate`

Brings the schema up to the latest version, running any pending migrations in order. If pg-boss is not yet installed, it creates the schema first (equivalent to `create`). If the schema is already current, it reports that and does nothing. Async index builds (normally run by the background worker) are inlined as `CREATE INDEX CONCURRENTLY` statements and fanned out across every partitioned queue table, so a migration run needs no live worker. Pass `--dry-run` to print the SQL — rendered from the database's actual current version — without executing it.

```bash
pg-boss migrate --connection-string postgres://localhost/myapp
pg-boss migrate --connection-string postgres://localhost/myapp --dry-run
```

### `create`

Installs the pg-boss schema from scratch at the latest version. If pg-boss is already installed in the target schema, it reports the existing version and makes no changes (use `migrate` to upgrade). Pass `--dry-run` to print the `CREATE` SQL without executing it.

```bash
pg-boss create --connection-string postgres://localhost/myapp
```

### `version`

Prints the installed schema version, the latest version pg-boss ships, and the number of pending migrations (or that the schema is up to date). Reports if pg-boss is not installed in the schema.

```bash
pg-boss version --connection-string postgres://localhost/myapp
```

### `doctor`

Compares the tables, indexes, functions, table columns (name, default, type, nullability), table constraints, and `job_state` enum pg-boss expects against the live database and reports any missing, invalid, or mismatched (dropped table, wrong index key order/predicate, altered function body, added/dropped columns, changed column defaults/types/nullability, added/dropped constraints, or changed enum values) objects, plus a warning for extra indexes. It exits `0` when the schema is clean and `1` when drift is found (or pg-boss is not installed), so it can gate a deploy — extra-index warnings do not affect the exit code. This is the CLI wrapper around [`detectSchemaDrift()`](api/ops#detectschemadrift). Default/type/nullability and constraint checks cover the fixed tables only (job/job_common/partitions are excluded); function, constraint, and enum checks are skipped on backends without `pg_get_functiondef`/`pg_get_constraintdef`, and type/default/constraint checks are skipped entirely on CockroachDB (its `INT8` typing and constraint rendering diverge from standard Postgres).

```bash
pg-boss doctor --connection-string postgres://localhost/myapp
```

Each drifted index is printed with the `CREATE INDEX` statement needed to fix it. A `mismatched` index — one whose definition was altered — shows the expected statement and the actual one side by side:

```
Schema "pgboss" version 37 (latest: 37)

MISMATCHED (definition differs) (1):
  job_common.job_common_i9 [predicate]
    expected: CREATE INDEX job_common_i9 ON pgboss.job_common (name, id) WHERE blocking AND (state = 'completed')
    actual:   CREATE INDEX job_common_i9 ON pgboss.job_common (name, id) WHERE blocking AND (state = 'active')

✗ Schema drift detected
```

Dropped managed tables print under `MISSING TABLES`. A `missing` index prints the `create:` statement to run; an `invalid` one prints the `rebuild:` statement to drop and recreate it (its definition is already correct, so there is nothing to compare against). Drifted functions print under `MISSING FUNCTIONS`/`MISMATCHED FUNCTIONS` with the expected (and, for a mismatch, actual) `CREATE FUNCTION` body; tables with column drift print under `COLUMN DRIFT` with their `missing:`/`unexpected:` column lists plus a `default`/`type`/`nullability <col>: expected … actual …` line per changed attribute; tables with constraint drift print under `CONSTRAINT DRIFT` with their `missing:`/`unexpected:` constraint definitions; and a changed `job_state` enum prints under `ENUM DRIFT` with the expected vs. actual value list. Standalone indexes on a managed table that pg-boss doesn't expect print under `⚠ EXTRA INDEXES` — a **warning only** (a stale pg-boss index or one you added; harmless), which does **not** change the `0` exit code. Example:

```
⚠ EXTRA INDEXES (present on a managed table but not expected — harmless) (1):
  job_common.job_common_custom_idx

MISSING TABLES (expected but absent) (1):
  warning

COLUMN DRIFT (missing/unexpected columns, or default/type/nullability drift) (1):
  queue
    default notify: expected false, actual true
    type retry_limit: expected integer, actual bigint
    nullability policy: expected NOT NULL, actual nullable

CONSTRAINT DRIFT (missing or unexpected constraints) (1):
  queue
    missing:    CHECK ((dead_letter IS DISTINCT FROM name))
```

`doctor` only diagnoses — it never changes the schema, and because it runs against a schema that is already at the latest version, a restart or `migrate` will not repair the drift it finds. Copy the printed statement to fix an index (insert `CONCURRENTLY` on a live table). See [Remediation](api/ops#detectschemadrift) for how to fix each category (recreate a missing index, drop a stale one, and so on).

### `rollback`

Reverts the last migration, moving the schema back one version. It refuses to go below the minimum version (prints `Cannot rollback: already at minimum version`) and reports if pg-boss is not installed. Pass `--dry-run` to print the rollback SQL without executing it.

```bash
pg-boss rollback --connection-string postgres://localhost/myapp
pg-boss rollback --connection-string postgres://localhost/myapp --dry-run
```

### `plans <subcommand>`

Prints SQL to stdout without touching the database — useful for review, manual execution, or checking into version control. Subcommands:

| Subcommand | Output |
|------------|--------|
| `create` (alias `construct`) | SQL to install the schema at the latest version |
| `migrate` (default) | SQL to migrate from version 0 to the latest, with async index builds inlined |
| `rollback` | SQL to roll back one version from the latest |

A connection is **optional**. Given one, `plans migrate` enumerates the partitioned queue tables so per-partition index builds are included; without one, it emits a `job_common`-only script and prints a note. All other subcommands need no connection.

```bash
# Output install SQL for a custom schema (no connection needed)
pg-boss plans create --schema myapp_jobs

# Output migration SQL, including per-partition index builds
pg-boss plans migrate --connection-string postgres://localhost/myapp

# Output rollback SQL
pg-boss plans rollback --schema myapp_jobs
```

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
   # schema name (default: pgboss)
   PGBOSS_SCHEMA=myapp_jobs pg-boss migrate
   ```

   Supported: `PGBOSS_DATABASE_URL`, `PGBOSS_HOST`, `PGBOSS_PORT`, `PGBOSS_DATABASE`, `PGBOSS_USER`, `PGBOSS_PASSWORD`, `PGBOSS_SCHEMA`.

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
| `--connection-string` | | PostgreSQL connection string |
| `--host` | | Database host |
| `--port` | | Database port |
| `--database` | `-d` | Database name |
| `--user` | `-u` | Database user |
| `--password` | `-p` | Database password |
| `--schema` | `-s` | pg-boss schema name (default: pgboss) |
| `--config` | `-c` | Path to config file (default: pgboss.json, .pgbossrc, .pgbossrc.json) |
| `--ssl` | | Enable SSL connection (`rejectUnauthorized: false`) |
| `--dry-run` | | Show SQL without executing (for `migrate`, `create`, `rollback`) |
| `--help` | `-h` | Show help |

> **Note:** `-c` is the short form for `--config` (a config file path), **not** `--connection-string`. The connection string has no short form.

## Examples

```bash
# Create schema in a new database
pg-boss create --connection-string postgres://localhost/myapp

# Run migrations in CI/CD pipeline
PGBOSS_DATABASE_URL=$PGBOSS_DATABASE_URL pg-boss migrate

# Preview migration SQL before running
pg-boss migrate --connection-string postgres://localhost/myapp --dry-run

# Check current schema version
pg-boss version --connection-string postgres://localhost/myapp

# Check for schema drift (exits 1 if drift is found)
pg-boss doctor --connection-string postgres://localhost/myapp

# Use a custom schema name
pg-boss migrate --connection-string postgres://localhost/myapp --schema myapp_jobs

# Load connection from a config file
pg-boss migrate -c ./config/pgboss.json

# Output SQL for creating schema (useful for review or manual execution)
pg-boss plans create --schema myapp_jobs
```
