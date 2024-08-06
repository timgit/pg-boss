Queueing jobs in Postgres from Node.js like a boss.

[![npm version](https://badge.fury.io/js/pg-boss.svg)](https://badge.fury.io/js/pg-boss)
[![Build](https://github.com/timgit/pg-boss/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/timgit/pg-boss/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/timgit/pg-boss/badge.svg?branch=master)](https://coveralls.io/github/timgit/pg-boss?branch=master)

```js
async function readme() {
  const PgBoss = require('pg-boss');
  const boss = new PgBoss('postgres://user:pass@host/database');

  boss.on('error', console.error)

  await boss.start()

  const queue = 'readme-queue'

  const id = await boss.send(queue, { arg1: 'read me' })

  console.log(`created job ${id} in queue ${queue}`)

  await boss.work(queue, async ([ job ]) => {
    console.log(`received job ${job.id} with data ${JSON.stringify(job.data)}`)
  })
}
```

pg-boss is a job queue built in Node.js on top of PostgreSQL in order to provide background processing and reliable asynchronous execution to Node.js applications.

pg-boss relies on [SKIP LOCKED](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/), a feature added to postgres specifically for message queues, in order to resolve record locking challenges inherent with relational databases. This brings the safety of guaranteed atomic commits of a relational database to your asynchronous job processing.

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (SQL, querying, and backups). It will be especially useful to those already relying on PostgreSQL that want to limit how many systems are required to monitor and support in their architecture.

## Features
* Exactly-once job delivery
* Backpressure-compatible polling workers
* Cron scheduling
* Pub/sub API for fan-out queue relationships
* Priority queues, deferral, retries (with exponential backoff), rate limiting, debouncing
* Table operations via SQL for bulk loads via COPY or INSERT
* Multi-master compatible (for example, in a Kubernetes ReplicaSet)
* Dead letter queues

## Requirements
* Node 20 or higher
* PostgreSQL 13 or higher

## Installation

```bash
# npm
npm install pg-boss

# yarn
yarn add pg-boss
```

## Documentation
* [Docs](docs/readme.md)

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

The test suite will try and create a new database named pgboss. The [config.json](test/config.json) file has the default credentials to connect to postgres. 
