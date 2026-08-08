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

bun-boss is a job queue for Bun applications that provides background processing and reliable asynchronous execution, backed by PostgreSQL (including embedded PGlite) or embedded SQLite.

On PostgreSQL it relies on SKIP LOCKED, a feature built specifically for message queues to resolve record locking challenges inherent with relational databases; on backends without it (such as SQLite) the same guarantee comes from an atomic, state-gated claim. Either way this provides exactly-once delivery and the safety of guaranteed atomic commits to asynchronous job processing.

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (SQL, querying, and backups). It will be especially useful to those already relying on a relational database that want to limit how many systems are required to monitor and support in their architecture.


## Summary
* Exactly-once job delivery
* Create jobs in an existing db transaction, including adapters for Bun's built-in SQL client, embedded PGlite, and embedded SQLite
* Backpressure-compatible polling workers, with optional low-latency LISTEN/NOTIFY delivery on adapters that support it (PGlite) — the built-in Bun SQL driver and SQLite fall back to polling
* Job dependency workflow orchestration
* Cron scheduling, job deferral
* Queue storage policies to support a variety of rate limiting, debouncing, and concurrency use cases
* Priority queues, dead letter queues with redrive, automatic retries with exponential backoff
* SQL support for interacting with Postgres directly (tables and stored functions), without the JS library
* Serverless function compatible
* Multi-master compatible on Postgres and PGlite (for example, in a Kubernetes ReplicaSet); embedded SQLite is single-writer
* [Additional database backends](docs/database-backends.md): embedded PGlite (in-process WASM Postgres) and embedded SQLite via Bun's built-in `SQL` client.

## Requirements
* PostgreSQL 13 or higher for the Postgres backend (not required when using embedded PGlite or SQLite)
* Bun 1.3.14 or higher — bun-boss runs on both Bun 1.3 and Bun 1.4 (the Rust rewrite); 1.4+ is recommended. The package ships TypeScript sources with no compile step, so it is consumed by Bun directly (Node cannot import it from `node_modules` without a bundler or transpiler), and the built-in database driver is Bun's own SQL client (see [database backends](docs/database-backends.md) for why 1.4 is preferred)

## Documentation
* [Docs site](https://khromov.github.io/bun-boss/) (also as plain markdown under [`docs/`](docs/introduction.md))
* For LLMs: [llms.txt](https://khromov.github.io/bun-boss/llms.txt) (index) and [llms-full.txt](https://khromov.github.io/bun-boss/llms-full.txt) (all docs in one file)
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
