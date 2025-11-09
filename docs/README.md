Queueing jobs in Postgres from Node.js like a boss.

[![npm version](https://badge.fury.io/js/pg-boss.svg?icon=si%3Anpm)](https://badge.fury.io/js/pg-boss)
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
