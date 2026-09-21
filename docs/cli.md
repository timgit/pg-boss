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
| `reindex` | Rebuild bloated job indexes with `REINDEX INDEX CONCURRENTLY` |
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

Reports anything in the live schema that no longer matches what pg-boss expects. The CLI wrapper around [`detectSchemaDrift()`](api/ops#detectschemadrift), which documents what is compared and what each backend skips.

Exits `0` when the schema is clean and `1` when drift is found or pg-boss is not installed, so it can gate a deploy. Extra-index warnings never change the exit code.

```bash
pg-boss doctor --connection-string postgres://localhost/myapp
```

Every entry prints with the statement that repairs it. A `mismatched` index shows the expected statement beside the one in the catalog:

```
Schema "pgboss" version 37 (latest: 37)

MISMATCHED (definition differs) (1):
  job_common.job_common_i9 [predicate]
    expected: CREATE INDEX job_common_i9 ON pgboss.job_common (name, id) WHERE blocking AND (state = 'completed')
    actual:   CREATE INDEX job_common_i9 ON pgboss.job_common (name, id) WHERE blocking AND (state = 'active')

✗ Schema drift detected
```

Every other category prints under a heading of its own — `MISSING TABLES`, `MISSING FUNCTIONS`, `MISMATCHED FUNCTIONS`, `COLUMN DRIFT`, `CONSTRAINT DRIFT`, `ENUM DRIFT`, and `⚠ EXTRA INDEXES` for indexes pg-boss does not expect, which are harmless and leave the exit code at `0`:

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

`doctor` diagnoses; the only thing it repairs is a leftover clock override, and only when asked with `--fix` (below). The schema it checks is already at the latest version, so a restart or `migrate` will not repair what it finds — run the printed statement yourself, inserting `CONCURRENTLY` on a live table. [Remediation](api/ops#detectschemadrift) covers every category.

#### `doctor --fix`

Repairs exactly one thing: a `job_now()` left overridden by a [TestClock](api/testing) whose run was killed before it released the clock. The override keeps time correct — the body falls through to real time for any session that never opted in — but it no longer inlines, so every statement that reads the clock pays a per-row function call. `--fix` restores the canonical body and drops the clock table, then re-runs the scan so the summary and exit code describe the repaired schema.

```bash
pg-boss doctor --connection-string postgres://localhost/myapp --fix
```

> **Warning:** a leftover override is indistinguishable from one a live instance is holding right now, which is why nothing repairs it automatically. Only run `--fix` when no instance holds a live TestClock against this schema.

Nothing else `doctor` finds is ever repaired.

### `reindex`

Rebuilds bloated job indexes with `REINDEX INDEX CONCURRENTLY`, one at a time, skipping any index the connected role does not own. Without flags it rebuilds only the indexes the bloat check flags; `--force` rebuilds every job index. `--dry-run` prints the SQL instead of running it. Unsupported on CockroachDB and YugabyteDB, which neither accept `REINDEX` nor report the catalog statistics the bloat check reads.

```bash
pg-boss reindex --connection-string postgres://localhost/myapp
pg-boss reindex --connection-string postgres://localhost/myapp --force --dry-run
```

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

   Supported: `PGBOSS_DATABASE_URL`, `PGBOSS_HOST`, `PGBOSS_PORT`, `PGBOSS_DATABASE`, `PGBOSS_USER`, `PGBOSS_PASSWORD`, `PGBOSS_SCHEMA`, `PGBOSS_BACKEND`.

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
     "schema": "pgboss",
     "backend": "postgres"
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
| `--backend` | | Database backend profile: `postgres` (default), `cockroachdb`, `yugabytedb`, `citus` |
| `--dry-run` | | Show SQL without executing (for `migrate`, `create`, `rollback`, `plans`, `reindex`) |
| `--force` | | Rebuild every job index, not just the bloated ones (for `reindex`) |
| `--fix` | | Restore a `job_now()` left overridden by a killed TestClock run (for `doctor`) |
| `--help` | `-h` | Show help |

> **Note:** `-c` is the short form for `--config` (a config file path), **not** `--connection-string`. The connection string has no short form.

## Backends

A connection string does not say which engine is on the other end of it, and the engines do not accept the same schema. `--backend` (or `PGBOSS_BACKEND`, or `"backend"` in the config file) names the profile, and every command that writes or prints schema — `create`, `migrate`, `rollback`, `plans`, `doctor`, `reindex` — uses it to pick the statements that backend supports. It is the same profile the library constructor takes, so the CLI and a running `PgBoss` produce the same schema.

Without it the CLI assumes stock PostgreSQL, which on CockroachDB means table partitioning, advisory locks, covering indexes and a column written in the transaction that added it — a migration that fails partway rather than up front.

```bash
# CockroachDB
pg-boss migrate --backend cockroachdb --connection-string postgres://root@localhost:26257/mydb

# YugabyteDB
PGBOSS_BACKEND=yugabytedb pg-boss migrate
```

`pglite` is in-process and has no connection string, so it is library-only and rejected here.

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
