Queueing jobs in Node.js using PostgreSQL like a boss.

[![npm version](https://badge.fury.io/js/pg-boss.svg)](https://badge.fury.io/js/pg-boss)
[![Build Status](https://travis-ci.org/timgit/pg-boss.svg?branch=master)](https://travis-ci.org/timgit/pg-boss)
[![Coverage Status](https://coveralls.io/repos/github/timgit/pg-boss/badge.svg?branch=master)](https://coveralls.io/github/timgit/pg-boss?branch=master)
[![Dependencies](https://david-dm.org/timgit/pg-boss.svg)](https://david-dm.org/timgit/pg-boss)
[![Node Version](https://img.shields.io/badge/node-0.10+-green.svg?maxAge=2592000)](https://www.nodejs.org)
[![PostgreSql Version](https://img.shields.io/badge/PostgreSQL-9.5+-blue.svg?maxAge=2592000)](http://www.postgresql.org)

```js
var PgBoss = require('pg-boss');
var boss = new PgBoss('postgres://username:password@localhost/database');
        
boss.start()
    .then(ready)
    .catch(error => console.error(error));

function ready() {
    boss.publish('work', {message: 'stuff'})
        .then(jobId => console.log(`sent job ${jobId}`));

    boss.subscribe('work', (job, done) => {
        console.log(`got job ${job.name} (${job.id}) ${JSON.stringify(job.data)}`);

        done().then(() => console.log('Confirmed done'));
    });
}
```

pg-boss is a message queue (aka job queue, task queue) built in Node.js on top of PostgreSQL in order to provide guaranteed messaging and asynchronous execution to your Node apps.  

Why would you consider using this queue over others?  Well, I will say this is a crowded space in npm, and I haven't personally used very many of them, but if you're already using Node and Postgres, you could avoid a conversation with Ops. I wrote this to remove a dependency on Redis (via the kue package), consolidating systems I have to support in production and well as upgrading to guaranteed message processing. This will likely cater to anyone already familiar with the simplicity of relational database semantics and operations (querying and backups, for example) as well as a low budget solution to a very common problem. 

##Features
* Guaranteed delivery and finalizing of jobs using a promise API
* Delayed jobs
* Job retries
* Job throttling (rate limiting)
* Distributed and/or clustered workers
* Automatic provisioning of required storage into a dedicated schema
* Automatic monitoring for expired jobs
* Automatic archiving for completed jobs

##Requirements
* Node 0.10 or higher (It may work on older versions, but who's using < 0.10? :)
* Postgres 9.5 or higher (see background below for rationale)

##Installation
`$ npm install pg-boss`

##Documentation
* [Docs](https://github.com/timgit/pg-boss/wiki) - (in progress)

##Background
pg-boss was created to leverage recent additions in PostreSQL 9.5
(specifically [SKIP LOCKED](http://blog.2ndquadrant.com/what-is-select-skip-locked-for-in-postgresql-9-5) and upserts)
which significantly enhances it's ability to act as a reliable, distributed message queue.
For example, I have a performance test which regularly completes 1000 jobs per second
([a bit longer in CI of course](https://travis-ci.org/timgit/pg-boss/jobs/127713018#L301)) once SKIP LOCKED was added
to my job fetch CTE.
