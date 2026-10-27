Queueing jobs in Postgres from Node.js like a boss.

[![Build](https://github.com/timgit/pg-boss/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/timgit/pg-boss/actions/workflows/ci.yml)
[![Coverage](https://coveralls.io/repos/github/timgit/pg-boss/badge.svg?branch=master)](https://coveralls.io/github/timgit/pg-boss?branch=master)
[![NPM](https://img.shields.io/npm/v/pg-boss)](https://www.npmjs.com/package/pg-boss)


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

pg-boss is a job queue built in Node.js on top of PostgreSQL. It gives Node.js applications background processing and reliable asynchronous execution.

pg-boss relies on SKIP LOCKED, a Postgres feature built for message queues that resolves the record locking problems relational databases have. Concurrent workers claim jobs without blocking each other, and job processing gets the guarantee of atomic commits.

pg-boss suits teams who know relational database semantics and operations (SQL, querying and backups). It's most useful to a team already running PostgreSQL that wants fewer systems to monitor and support.


## Summary
* Create jobs in an existing db transaction, including adapters for popular ORMs such as Drizzle, Knex, Kysely, Prisma
* Backpressure-compatible polling workers, including support for LISTEN/NOTIFY low latency delivery
* Job dependency workflow orchestration
* Cron and RRULE scheduling, job deferral
* Queue storage policies to support a variety of rate limiting, debouncing, and concurrency use cases
* Priority queues, dead letter queues with redrive, automatic retries with exponential backoff
* Pub/sub API for fan-out queue relationships
* SQL support for non-Node.js runtimes for most operations
* Serverless function compatible
* [OpenTelemetry](https://pgboss.io/opentelemetry) traces and metrics
* Multi-master compatible (for example, in a Kubernetes ReplicaSet)
* [Additional database backends](https://pgboss.io/database-backends) for Postgres-based databases such as CockroachDB and Citus, and embedded PGlite to run entirely in-process.

## CLI

pg-boss includes a command-line interface for managing database migrations without writing code. Use it in CI/CD pipelines and database setup scripts, or to manage the schema by hand.

See the [CLI documentation](https://pgboss.io/cli) for details.

## Dashboard

A web dashboard in the [`@pg-boss/dashboard`](https://www.npmjs.com/package/@pg-boss/dashboard) package monitors jobs, queues and schedules.

See the [dashboard documentation](https://pgboss.io/dashboard) for details.

## Proxy

An HTTP proxy in the [`@pg-boss/proxy`](https://www.npmjs.com/package/@pg-boss/proxy) package supports use cases such as platform compatibility, connection pooling and scalability.

See the [proxy documentation](https://pgboss.io/proxy) for details.

## Pro 🚀

[pg-boss Pro](https://pgboss.io/pro/) is built for teams running pg-boss in production. It has two components, the Pro Console in the browser and the Pro API over HTTP. In the Console, users send, retry and delete jobs, create queues and schedules, and run batch operations across queues, as their role allows. Every change is recorded in the audit log. Through the API, scripts, CI jobs and other systems call pg-boss's methods using an API token. Pro also adds queue health monitoring and alert rules that reach whoever is on call by email, webhook or a paging service, along with single sign-on and Prometheus metrics. Pro is built and supported by the author of pg-boss, and it's sold as a yearly or monthly subscription. Subscriptions, along with sponsorship, pay for the maintenance of pg-boss.

## Sponsors

pg-boss is MIT licensed and always will be. One person maintains it, and sponsorship pays for the maintenance, security response and support behind it.

[Become a sponsor](https://github.com/sponsors/timgit), or see everyone who already does on the [sponsors page](https://pgboss.io/sponsors).

<!-- sponsors:start The logos below are generated from GitHub Sponsors by scripts/sync-sponsors.js. Do not edit them directly. -->
<div style="display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin: 1.5rem 0;">
  <a href="https://superpower.com/" target="_blank" rel="noopener"><img src="https://avatars.githubusercontent.com/u/114334709?s=256&amp;v=4" alt="Superpower" title="Superpower" width="96" height="96" style="border-radius: 8px;"></a>
  <a href="https://altruistiq.com/" target="_blank" rel="noopener"><img src="https://avatars.githubusercontent.com/u/88195975?s=256&amp;v=4" alt="Altruistiq" title="Altruistiq" width="64" height="64" style="border-radius: 8px;"></a>
  <a href="https://wasp.sh/" target="_blank" rel="noopener"><img src="https://avatars.githubusercontent.com/u/55102317?s=256&amp;v=4" alt="wasp-lang" title="wasp-lang" width="64" height="64" style="border-radius: 8px;"></a>
  <a href="https://github.com/Ferry-Health" target="_blank" rel="noopener"><img src="https://avatars.githubusercontent.com/u/158637456?s=256&amp;v=4" alt="Ferry Health" title="Ferry Health" width="64" height="64" style="border-radius: 8px;"></a>
</div>
<!-- sponsors:end -->

## Documentation
* [Docs](https://pgboss.io/)

## Requirements
* Node 22.12 or higher, or Bun
* PostgreSQL 13 or higher

## Contributing
To set up a development environment for this library:

```bash
git clone https://github.com/timgit/pg-boss.git
npm install
```

To run the test suite, linter and code coverage:
```bash
npm run cover
```

The test suite tries to create a database named pgboss. The [config.json](https://github.com/timgit/pg-boss/blob/master/test/config.json) file has the default credentials for connecting to Postgres.

The [Docker Compose](https://github.com/timgit/pg-boss/blob/master/docker-compose.yaml) file starts a local Postgres instance for testing:

```bash
docker compose up
```
