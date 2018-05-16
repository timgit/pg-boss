Queueing jobs in Node.js using PostgreSQL like a boss.

[![PostgreSql Version](https://img.shields.io/badge/PostgreSQL-9.5+-blue.svg?maxAge=2592000)](http://www.postgresql.org)
[![npm version](https://badge.fury.io/js/pg-boss.svg)](https://badge.fury.io/js/pg-boss)
[![Build Status](https://travis-ci.org/timgit/pg-boss.svg?branch=master)](https://travis-ci.org/timgit/pg-boss)
[![Coverage Status](https://coveralls.io/repos/github/timgit/pg-boss/badge.svg?branch=master)](https://coveralls.io/github/timgit/pg-boss?branch=master)
[![Dependencies](https://david-dm.org/timgit/pg-boss.svg)](https://david-dm.org/timgit/pg-boss)

```js
const PgBoss = require('pg-boss');
const boss = new PgBoss('postgres://user:pass@host/database');

boss.on('error', onError);

const queue = 'some-queue-name';

boss.start()
  .then(ready)
  .catch(onError);

function ready() {
  boss.publish(queue, {param1: 'parameter1'})
    .then(jobId => console.log(`created job ${jobId}`))
    .catch(onError);

  boss.subscribe(queue, someJobHandler)
    .then(() => console.log(`subscribed to ${queue}`))
    .catch(onError);
}

function someJobHandler(job) {
  console.log(`received job ${job.id}`);
  console.log(`data: ${JSON.stringify(job.data)}`);

  job.done()
    .then(() => console.log(`job ${job.id} completed`))
    .catch(onError);
}

function onError(error) {
  console.error(error);
}
```

pg-boss is a message queue (aka job queue, task queue) built in Node.js on top of PostgreSQL in order to provide guaranteed messaging and asynchronous execution to your Node apps.  

Why would you consider using this queue over others? pg-boss was created to leverage recent additions in PostgreSQL 9.5
(specifically [SKIP LOCKED](http://blog.2ndquadrant.com/what-is-select-skip-locked-for-in-postgresql-9-5) and upserts)
which significantly enhance its ability to act as a reliable, distributed message queue. I wrote this to remove a dependency on Redis (via the kue package), consolidating systems I have to support in production as well as upgrading to guaranteed message processing (hint: [Redis persistence docs](https://redis.io/topics/persistence#ok-so-what-should-i-use)). 

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (querying and backups, for example).

## Features
* Guaranteed delivery and finalizing of jobs using a promise API
* Delayed jobs
* Job retries
* Job throttling (singleton jobs and rate limiting)
* Configurable job concurrency
* Distributed and/or clustered workers
* State-based subscriptions to support orchestrations/sagas
* Ad-hoc job fetching and completion for external integrations (such as web APIs)
* Automatic provisioning of required storage into a dedicated schema
* Automatic monitoring for expired jobs
* Automatic archiving for completed jobs

## Requirements
* Node 4 or higher
* PostgreSQL 9.5 or higher

## Installation
`$ npm install pg-boss`

## Documentation
* [Usage](docs/usage.md)
* [Configuration](docs/configuration.md)
