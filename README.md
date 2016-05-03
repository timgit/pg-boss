Queueing jobs in Node.js using PostgreSQL like a boss.

[![PostgreSql Version](https://img.shields.io/badge/PostgreSQL-9.5-blue.svg?maxAge=2592000)](http://www.postgresql.org)
[![npm](https://img.shields.io/npm/v/pg-boss.svg?maxAge=2592000)](pg-boss)
[![Build Status](https://travis-ci.org/timgit/pg-boss.svg?branch=master)](https://travis-ci.org/timgit/pg-boss)
[![Coverage Status](https://coveralls.io/repos/github/timgit/pg-boss/badge.svg?branch=master)](https://coveralls.io/github/timgit/pg-boss?branch=master)

```
var PgBoss = require('pg-boss');
var boss = new PgBoss('postgres://username:password@localhost/database');
boss.on('error', error);
boss.on('ready', ready);

boss.start();

function ready() {
    boss.publish('work', {message: 'stuff'})
        .then(function(jobId){
            console.log('created job ' + jobId);
        });

    boss.subscribe('work', null, function(data, done) {
        console.log('received work job with payload ' + data.message);

        done().then(function() {
            console.log('Confirmed done');
        });
    });
}

function error(err){
    console.error(err);
}
```

##Installation
`$ npm install pg-boss`