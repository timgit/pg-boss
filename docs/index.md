---
layout: home

hero:
  name: pg-boss
  tagline: Queueing jobs in Postgres from Node.js like a boss
  actions:
    - theme: brand
      text: Get Started
      link: /introduction
    - theme: alt
      text: API Reference
      link: /api/constructor

---

<!-- The content below is generated from README.md by scripts/sync-readme.js. Do not edit it directly. -->

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


## Summary
* Exactly-once job delivery
* Create jobs in an existing db transaction, including adapters for popular ORMs such as Drizzle, Knex, Kysely, Prisma
* Backpressure-compatible polling workers, including support for LISTEN/NOTIFY low latency delivery
* Job dependency workflow orchestration
* Cron scheduling, job deferral
* Queue storage policies to support a variety of rate limiting, debouncing, and concurrency use cases
* Priority queues, dead letter queues with redrive, automatic retries with exponential backoff
* Pub/sub API for fan-out queue relationships
* SQL support for non-Node.js runtimes for most operations
* Serverless function compatible
* Multi-master compatible (for example, in a Kubernetes ReplicaSet)
* [Additional database backends](/database-backends) for Postgres-based databases such as CockroachDB, YugabyteDB and Citus. Or, use embedded PGlite for running entirely in-process.

## CLI

pg-boss includes a command-line interface if needed for managing database migrations without writing code. This is useful for CI/CD pipelines, database setup scripts, or manual schema management.

See the [CLI documentation](/cli) for details.

## Dashboard

A web-based dashboard is available in the [`@pg-boss/dashboard`](https://www.npmjs.com/package/@pg-boss/dashboard) package for monitoring and managing jobs, queues and schedules.

See the [dashboard documentation](/dashboard) for details.

## Proxy

A HTTP proxy is available in the [`@pg-boss/proxy`](https://www.npmjs.com/package/@pg-boss/proxy) package if needed to support use cases such as platform compatibility and connection pooling or scalability.

See the [proxy documentation](/proxy) for details.

## Requirements
* Node 22.12 or higher for CommonJS's require(esm)
* PostgreSQL 13 or higher

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
