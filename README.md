Queueing jobs in Node.js using PostgreSQL like a boss.

[![npm version](https://badge.fury.io/js/pg-boss.svg)](https://badge.fury.io/js/pg-boss)
[![Build Status](https://travis-ci.org/timgit/pg-boss.svg?branch=master)](https://travis-ci.org/timgit/pg-boss)
[![Coverage Status](https://coveralls.io/repos/github/timgit/pg-boss/badge.svg?branch=master)](https://coveralls.io/github/timgit/pg-boss?branch=master)
[![Dependencies](https://david-dm.org/timgit/pg-boss.svg)](https://david-dm.org/timgit/pg-boss)
[![PostgreSql Version](https://img.shields.io/badge/PostgreSQL-9.5+-blue.svg?maxAge=2592000)](http://www.postgresql.org)
```
var PgBoss = require('pg-boss');
var boss = new PgBoss('postgres://username:password@localhost/database');

boss.on('error', error => console.error(error));
boss.on('ready', ready);

boss.start();

function ready() {
    boss.publish('work', {message: 'stuff'})
        .then(jobId => console.log(`created job ${jobId}`));

    boss.subscribe('work', (job, done) => {
        console.log(`received job ${job.name}, ID ${job.id}, payload ${JSON.stringify(job.data)}`);

        done().then(() => console.log('Confirmed done'));
    });
}
```

##Installation
`$ npm install pg-boss`

##Features
* Guaranteed delivery and finalizing of jobs using a promise API
* Delayed jobs
* Distributed job submission throttling
* Automatic provisioning of required storage into an dedicated schema
* Automatic monitoring for expired jobs
* Automatic archiving for completed jobs

##Background
pg-boss was created to leverage recent additions in PostreSQL 9.5 (specifically [SKIP LOCKED](src) and upserts)
which significantly enhances it's ability to act as a reliable, distributed message queue.