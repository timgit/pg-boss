> [!WARNING]
> **Work in progress.** bun-boss is an experimental fork of [pg-boss](https://github.com/timgit/pg-boss) that runs on Bun and adds SQLite and in-memory backends. It's under active development and not yet production-ready — expect breaking changes. Postgres (including embedded PGlite) and SQLite (`backend: 'sqlite'` through Bun's built-in `SQL` client — see [Database Backends](docs/database-backends.md#sqlite-embedded-via-bunsql)) work today; a dedicated in-memory backend is not implemented yet (SQLite on `sqlite://:memory:` covers that use in the meantime).

Queueing jobs in Postgres, SQLite, and memory from Bun like a boss.

[![Build](https://github.com/khromov/bun-boss/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/khromov/bun-boss/actions/workflows/ci.yml)


```js
async function readme() {
  const { BunBoss } = require('bun-boss');
  const boss = new BunBoss('postgres://user:pass@host/database');

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

bun-boss is a job queue built on top of PostgreSQL in order to provide background processing and reliable asynchronous execution to Bun applications.

It relies on Postgres's SKIP LOCKED, a feature built specifically for message queues to resolve record locking challenges inherent with relational databases. This provides exactly-once delivery and the safety of guaranteed atomic commits to asynchronous job processing.

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (SQL, querying, and backups). It will be especially useful to those already relying on PostgreSQL that want to limit how many systems are required to monitor and support in their architecture.


## Summary
* Exactly-once job delivery
* Create jobs in an existing db transaction, including adapters for Bun's built-in SQL client and embedded PGlite
* Backpressure-compatible polling workers, including support for LISTEN/NOTIFY low latency delivery
* Job dependency workflow orchestration
* Cron scheduling, job deferral
* Queue storage policies to support a variety of rate limiting, debouncing, and concurrency use cases
* Priority queues, dead letter queues with redrive, automatic retries with exponential backoff
* Pub/sub API for fan-out queue relationships
* SQL support for non-Node.js runtimes for most operations
* Serverless function compatible
* Multi-master compatible (for example, in a Kubernetes ReplicaSet)
* [Additional database backends](docs/database-backends.md): embedded PGlite (in-process WASM Postgres) and embedded SQLite via Bun's built-in `SQL` client.

## Requirements
* PostgreSQL 13 or higher
* Bun 1.3.14 or higher, 1.4+ recommended — the package ships TypeScript sources with no compile step, so it is consumed by Bun directly (Node cannot import it from `node_modules` without a bundler or transpiler), and the built-in database driver is Bun's own SQL client (see [database backends](docs/database-backends.md) for why 1.4 is preferred)

## Documentation
* [Docs](docs/introduction.md) in this repo
* [Upstream docs](https://pgboss.io/) for everything the fork has not changed

## Contributing
To setup a development environment for this library:

```bash
git clone https://github.com/khromov/bun-boss.git
bun install
```

The test suite, linter and every package script run under Bun.

To run the test suite, linter and code coverage:
```bash
bun run cover
```

The test suite will try and create a new database named pgboss. The [config.json](test/config.json) file has the default credentials to connect to postgres.

The [Docker Compose](docker-compose.yaml) file can be used to start a local postgres instance for testing:

```bash
docker compose up -d db
```
