## v10

* Postgres 12 and Node 18 required
 
* Created policy queues.  Each queue is partitioned into dedicated storage (via postgres declarative partitioning)

* cascade configuration for send() and insert() from policy queue and then global settings in the constructor 

* Introduce dead letter queue config
   * Removes completion jobs and onComplete config
   * Allows retries in dlq, since they become just like any other queue

* Add primary key to archive
   * allows replication of database for read-replica and/or HA use cases
   * Existing archive table will be renamed to archive_backup and kept until the next release of pgboss

* Allow instances to connect without trying to migrate to latest version (instances that should be able to process jobs, but not have access to schema changes or upgrades)

New constructor option
```js
  migrate: false
```
* Update existing constructor options for maintenance and scheduling:
```js
  supervise: true,
  schedule: true
```
* consolidate failed states: expired => failed

* Add manual maintenance API for one-off upgrade API without processing queues
```js
  await boss.maintain()
```

 ## TODO

* Add peek API for running TOP N queries against job tables