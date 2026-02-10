Queueing jobs in Postgres from Node.js like a boss.

[![NPM](https://nodei.co/npm/pg-boss.svg?style=shields&color=blue)](https://nodei.co/npm/pg-boss/)
[![Build](https://github.com/timgit/pg-boss/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/timgit/pg-boss/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/timgit/pg-boss/badge.svg?branch=master)](https://coveralls.io/github/timgit/pg-boss?branch=master)

```js
async function readme() {
  const { PgBoss } = require('pg-boss');
  const boss = new PgBoss('postgres://user:pass@host/database');

  boss.on('error', console.error)

  await boss.start()

  const queue = 'readme-queue'

  await boss.createQueue(queue)

  const id = await boss.send(queue, { arg1: 'read me' })

  console.log(`created job ${id} in queue ${queue}`)

  await boss.work(queue, async ([ job ]) => {
    console.log(`received job ${job.id} with data ${JSON.stringify(job.data)}`)
  })
}

readme()
  .catch(err => {
    console.log(err)
    process.exit(1)
  })
```

pg-boss is a job queue built in Node.js on top of PostgreSQL in order to provide background processing and reliable asynchronous execution to Node.js applications.

pg-boss relies on Postgres's SKIP LOCKED, a feature built specifically for message queues to resolve record locking challenges inherent with relational databases. This provides exactly-once delivery and the safety of guaranteed atomic commits to asynchronous job processing.

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (SQL, querying, and backups). It will be especially useful to those already relying on PostgreSQL that want to limit how many systems are required to monitor and support in their architecture.


## Summary <!-- {docsify-ignore-all} -->
* Exactly-once job delivery
* Create jobs within your existing database transaction
* Backpressure-compatible polling workers
* Cron scheduling
* Queue storage policies to support a variety of rate limiting, debouncing, and concurrency use cases
* Priority queues, dead letter queues, job deferral, automatic retries with exponential backoff
* Pub/sub API for fan-out queue relationships
* SQL support for non-Node.js runtimes for most operations
* Serverless function compatible
* Multi-master compatible (for example, in a Kubernetes ReplicaSet)

## CLI

pg-boss includes a command-line interface for managing database migrations without writing code. This is useful for CI/CD pipelines, database setup scripts, or manual schema management.

### Installation

When installed globally, the CLI is available as `pg-boss`:

```bash
npm install -g pg-boss
pg-boss --help
```

Or run directly with npx:

```bash
npx pg-boss --help
```

### Commands

| Command | Description |
|---------|-------------|
| `migrate` | Run pending migrations (creates schema if not exists) |
| `create` | Create initial pg-boss schema |
| `version` | Show current schema version |
| `rollback` | Rollback the last migration |
| `plans <subcommand>` | Output SQL without executing (subcommands: `create`, `migrate`, `rollback`) |

### Connection Configuration

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

### Options

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

### Examples

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

## Dashboard

A web-based dashboard is available for monitoring and managing pg-boss job queues. It provides an overview of queue statistics, job browsing and filtering, job actions (create, cancel, retry, resume, delete), warning history, and multi-database support.

```bash
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-dashboard
```

See the [dashboard documentation](https://github.com/timgit/pg-boss/blob/master/packages/dashboard/README.md) for full configuration and deployment options.

## Requirements
* Node 22.12 or higher for CommonJS's require(esm)
* PostgreSQL 13 or higher

## Documentation
* [Docs](https://timgit.github.io/pg-boss/)

## Contributing
To setup a development environment for this library:

```bash
git clone https://github.com/timgit/pg-boss.git
npm install
```

To run the test suite, linter and code coverage:
```bash
npm run cover
```

The test suite will try and create a new database named pgboss. The [config.json](https://github.com/timgit/pg-boss/blob/master/test/config.json) file has the default credentials to connect to postgres.

The [Docker Compose](https://github.com/timgit/pg-boss/blob/master/docker-compose.yaml) file can be used to start a local postgres instance for testing:

```bash
docker compose up
```
