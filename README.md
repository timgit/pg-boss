Queueing jobs in Node.js using PostgreSQL like a boss.

[![PostgreSql Version](https://img.shields.io/badge/PostgreSQL-9.5+-blue.svg?maxAge=2592000)](http://www.postgresql.org)
[![npm version](https://badge.fury.io/js/pg-boss.svg)](https://badge.fury.io/js/pg-boss)
[![Build Status](https://travis-ci.com/timgit/pg-boss.svg?branch=master)](https://travis-ci.com/timgit/pg-boss)
[![Coverage Status](https://coveralls.io/repos/github/timgit/pg-boss/badge.svg?branch=master)](https://coveralls.io/github/timgit/pg-boss?branch=master)

```js
async function readme() {
  const PgBoss = require('pg-boss');
  const boss = new PgBoss('postgres://user:pass@host/database');

  boss.on('error', error => console.error(error));

  await boss.start();

  const queue = 'some-queue';

  let jobId = await boss.publish(queue, { param1: 'foo' })

  console.log(`created job in queue ${queue}: ${jobId}`);

  await boss.subscribe(queue, someAsyncJobHandler);
}

async function someAsyncJobHandler(job) {
  console.log(`job ${job.id} received with data:`);
  console.log(JSON.stringify(job.data));

  await doSomethingAsyncWithThis(job.data);
}
```

pg-boss is a job queue built in Node.js on top of PostgreSQL in order to provide background processing and reliable asynchronous execution to Node.js applications.

pg-boss relies on [SKIP LOCKED](http://blog.2ndquadrant.com/what-is-select-skip-locked-for-in-postgresql-9-5), a feature introduced in PostgreSQL 9.5 written specifically for message queues, in order to resolve record locking challenges inherent with relational databases. This brings the safety of guaranteed atomic commits of a relational database to your asynchronous job processing.

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (SQL, querying, and backups). It will be especially useful to those already relying on PostgreSQL that want to limit how many systems are required to monitor and support in their architecture.

## Features
* Backpressure-compatible subscriptions for monitoring queues on an interval (with configurable concurrency)
* Distributed cron-based job scheduling with database clock synchronization
* Job deferral, retries (with exponential backoff), throttling, rate limiting, debouncing
* Job completion subscriptions for orchestrations/sagas
* Direct publish, fetch and completion APIs for custom integrations
* Batching API for chunked job fetching
* Direct table access for bulk loads via COPY or INSERT
* Multi-master compatible when running multiple instances (for example, in a Kubernetes ReplicaSet)
* Automatic provisioning of required storage into a dedicated schema
* Automatic maintenance operations to manage table growth

## Requirements
* Node 12 or higher
* PostgreSQL 9.5 or higher

## Installation

``` bash
# npm
npm install pg-boss

# yarn
yarn add pg-boss
```

## Documentation
* [Usage](docs/usage.md)
* [Configuration](docs/configuration.md)

## Contributing

To setup a development environment for this library:

```bash
git clone https://github.com/timgit/pg-boss.git
npm install

```

To run the test suite you will need to pgboss access to an empty postgres database. You can set one up using the following commands on a local postgres instance:

```sql
CREATE DATABASE pgboss;
CREATE user postgres WITH PASSWORD 'postgres';
GRANT ALL PRIVILEGES ON DATABASE pgboss to postgres;
-- run the following command in the context of the pgboss database
CREATE EXTENSION pgcrypto;
```

If you use a different database name, username or password, or want to run the test suite against a database that is running on a remote machine then you will need to edit the `test/config.json` file with the appropriate connection values.

You can then run the linter and test suite using:

```bash
npm test
```
