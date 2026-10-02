# Introduction

pg-boss is a job queue for Node.js built on PostgreSQL.

Some work doesn't belong inside a web request: sending an email, rendering a PDF report, calling a slow third-party API. Even if the work could be done quickly, some tasks are important enough that you want a stronger guarantee they get done, especially when money is involved, such as an online order. A job queue lets you hand that work off. Your code sends a job, a worker picks it up and runs it, and if it fails it is retried, so the work isn't lost when a process restarts or a dependency is briefly down.

Queues help in other ways too, such as keeping calls to a rate-limited dependency under its limit or even absorbing a brief spike in volume by processing work at a steady pace.

## Quick start

```bash
npm install pg-boss
```

```js
import { PgBoss } from 'pg-boss'

const boss = new PgBoss('postgres://user:pass@host/database')
boss.on('error', console.error)

await boss.start()
await boss.createQueue('email-send')

await boss.work('email-send', async ([job]) => {
  console.log(`sending an email to ${job.data.to}`)
})

await boss.send('email-send', { to: 'ada@example.com' })
```

The first `start()` creates pg-boss's tables in their own schema. If your database user can't create a schema, see [Database install](./install).

## The moving parts

- **Queue**: a named stream of jobs, created with [`createQueue()`](./api/queues#createqueue-name-queue) before anything is sent to it. Its options set retries, expiration, retention, and a policy for how duplicates are handled.
- **Job**: one piece of work with a JSON payload, added with [`send()`](./api/jobs#send-name-data-options). It can be delayed, prioritized, or [scheduled](./api/scheduling) on a cron.
- **Worker**: your handler for a queue, registered with [`work()`](./api/workers#work-name-options-handler). It fetches jobs as they become ready, marks each completed when your handler returns, and fails it (to be retried) when it throws.
- **Instance**: a `PgBoss` object. It's meant to be long-lived: create one per process, call `start()` once when the process starts and `stop()` when it shuts down, rather than creating one per request or per job. Any number of Node.js processes can run one against the same database, sending jobs, working them or both, including from serverless functions. Each keeps its own connection pool, so your database's connection limit caps how many can run at once. Each also records itself in the [instance table](./sql/instance-table) while it runs, so you can see which instances are connected, which queues each one is working on, and whether it is still alive using [`getInstances()`](./api/ops#getinstances).

## What to expect

**Jobs are delivered at least once.** If a worker crashes, or a job runs past its expiration, the job is retried, so a handler can run more than once for the same job. Write handlers so that running one twice does no harm. See [heartbeat vs expiration](./api/queues#heartbeat-vs-expiration).

**Jobs can be part of your own transactions.** Because jobs live in your database, you can send one in the same transaction as the data change it belongs to: the job exists if, and only if, the change commits. See [Adapters](./api/adapters).

**Workers don't block each other.** pg-boss claims jobs with Postgres's [SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE), so many workers can share a queue, each getting different jobs, with the safety of an ordinary transaction.

**You own the queue.** It runs in your database rather than a hosted queue service, so there are no per-job charges and nothing ties it to one provider: it moves wherever your database does. pg-boss is open source under the MIT license.

pg-boss suits teams that already run PostgreSQL and would rather not add another system to operate and monitor.

## Job states

```
created ──► active ──► completed
               │
               ├──► retry ──► active (again)
               └──► failed
```

All jobs start out in the `created` state and become `active` via [`fetch(name, options)`](./api/jobs#fetch-name-options) or in a polling worker via [`work()`](./api/workers#work). 

In a worker, when your handler function completes, jobs will be marked `completed` automatically unless previously deleted via [`deleteJob(name, id)`](./api/jobs#deletejob-name-id-options). If an unhandled error is thrown in your handler, the job will usually enter the `retry` state, and then the `failed` state once all retries have been attempted. 

Uncompleted jobs may also be assigned to `cancelled` state via [`cancel(name, id)`](./api/jobs#cancel-name-id-options), where they can be moved back into `created` via [`resume(name, id)`](./api/jobs#resume-name-id-options). Failed jobs can be retried via [`retry(name, id)`](./api/jobs#retry-name-id-options).

All jobs that are not actively deleted during processing will remain in `completed`, `cancelled` or `failed` state until they are automatically removed, according to the queue's [retention options](./api/queues#createqueue-name-queue).
