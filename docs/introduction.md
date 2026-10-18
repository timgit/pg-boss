# Introduction

pg-boss is a job queue for Node.js built on PostgreSQL.

Some work doesn't belong inside a web request: sending an email, rendering a PDF report, calling a slow third-party API. Even quick work can need a stronger guarantee that it gets done, especially when money is involved, as with an online order. A job queue lets you hand that work off. Your code sends a job, and a worker picks it up and runs it. If the job fails, pg-boss retries it, so the work isn't lost when a process restarts or a dependency is briefly down.

A queue also keeps calls to a rate-limited dependency under its limit, and it absorbs a brief spike in volume by processing work at a steady pace.

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

## Core concepts

- **Queue**: a named stream of jobs, created with [`createQueue()`](./api/queues#createqueue-name-queue) before anything is sent to it. Its options set retries, expiration, retention, and a policy for how duplicates are handled.
- **Job**: one piece of work with a JSON payload, added with [`send()`](./api/jobs#send-name-data-options). It can be delayed, prioritized, or [scheduled](./api/scheduling) on a cron.
- **Worker**: your handler for a queue, registered with [`work()`](./api/workers#work-name-options-handler). It fetches jobs as they become ready, marks each completed when your handler returns, and fails it (to be retried) when it throws.
- **Instance**: a `PgBoss` object. It's meant to be long-lived. Create one per process, call `start()` once when the process starts, and call `stop()` when it shuts down. Don't create one per request or per job. Any number of Node.js processes can run one against the same database, sending jobs, working them or both, including from serverless functions. Each keeps its own connection pool, so your database's connection limit caps how many can run at once. Each also records itself in the [instance table](./sql/instance-table) while it runs. [`getInstances()`](./api/ops#getinstances-options) then shows which instances are connected, which queues each one works on, and whether each is still alive.

## Key properties

**Jobs are delivered at least once.** If a worker crashes, or a job runs past its expiration, pg-boss retries the job, so a handler can run more than once for the same job. Write handlers so that running one twice does no harm. See [heartbeat vs expiration](./api/queues#heartbeat-vs-expiration).

**Jobs can be part of your own transactions.** Because jobs live in your database, you can send one in the same transaction as the data change it belongs to. The job then exists if, and only if, the change commits. See [Adapters](./api/adapters).

**Workers don't block each other.** pg-boss claims jobs with Postgres's [SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE), so many workers can share a queue, each getting different jobs, with the safety of an ordinary transaction.

**You own the queue.** It runs in your own database, so no hosted queue service charges you per job or ties you to one provider. It moves wherever your database does. pg-boss is open source under the MIT license.

pg-boss suits teams that already run PostgreSQL and would rather not add another system to operate and monitor.

## Job states

```
created ──► active ──► completed
               │
               ├──► retry ──► active (again)
               └──► failed
```

Every job starts in the `created` state. It becomes `active` when [`fetch(name, options)`](./api/jobs#fetch-name-options) returns it, or when a polling worker started with [`work()`](./api/workers#work) picks it up.

In a worker, pg-boss marks a job `completed` when your handler returns, unless something already deleted it with [`deleteJob(name, id)`](./api/jobs#deletejob-name-id-options). If your handler throws, the job usually moves to `retry`, and then to `failed` once it has used all its retries.

[`cancel(name, id)`](./api/jobs#cancel-name-id-options) moves an unfinished job to the `cancelled` state, and [`resume(name, id)`](./api/jobs#resume-name-id-options) moves it back to `created`. [`retry(name, id)`](./api/jobs#retry-name-id-options) retries a failed job.

A job that nobody deletes during processing stays in the `completed`, `cancelled` or `failed` state until pg-boss removes it under the queue's [retention options](./api/queues#createqueue-name-queue).
