# Dashboard

The [`@pg-boss/dashboard`](https://www.npmjs.com/package/@pg-boss/dashboard) package is a web dashboard for monitoring jobs, queues and schedules. The dashboard is read-only except for [retry, cancel and resume](#job-actions) on a job's detail page. The [pg-boss Pro Console](./pro/index.md) adds sending and deleting jobs, changing many jobs at once, and creating queues and schedules for authenticated users with assigned [roles](./pro/roles.md). The Pro Console also adds alerts and an audit log.

![A queue's waiting jobs over the last 24 hours](./images/dashboard-queue-waiting.webp){.light-only}
![A queue's waiting jobs over the last 24 hours](./images/dashboard-queue-waiting-dark.webp){.dark-only}

## Features

- **Overview**: Aggregate statistics, top queues, instances and recent warnings
- **Queues**: View all queues with cached statistics
- **Queue Metrics**: Chart a queue's counts over time from its recorded history
- **Schedules**: Each schedule with its queue, expression and next occurrence
- **Subscriptions**: Each event and the queues subscribed to it
- **Instances**: The pg-boss instances registered in the database, with their workers and options
- **Migrations**: The async migration commands, such as index builds, and their status
- **Job List**: View jobs with state and queue filtering
- **Job Details**: View full job payloads, output data, and metadata
- **Warning History**: Browse the warnings pg-boss emitted earlier, when `persistWarnings` is enabled
- **Multi-Schema Support**: Monitor multiple pg-boss instances from a single dashboard
- **Mobile Responsive**: Full functionality on mobile devices with collapsible sidebar
- **Shareable URLs**: A shared URL opens the same database and filters

## Pages

### Overview

The landing page has one row of figures across all queues: jobs ready to run (with how many are queued in all, deferred or blocked), active, failed, and stored in total (with how many of those have completed or been cancelled). Below it are the five queues holding the most jobs, each with a ready-count trend sparkline and a status badge. The badge reads backlogged when the queue holds more queued jobs than its `warningQueueSize`, processing when it has active jobs, ready when it has ready jobs and none active, and idle otherwise. In a column beside the figures and the top queues, the **Instances** card shows how many [instances](#instances) are live and how many have gone quiet, the hosts they run on and the pg-boss versions they run. A bar splits the server's connection limit between pg-boss, other applications and the connections still free. The most recent warnings are under it.

![Overview page](./images/dashboard-overview.webp){.light-only}
![Overview page](./images/dashboard-overview-dark.webp){.dark-only}

### Jobs

Recently created jobs across all queues. Filter by job ID, queue, state and minimum retry count. The queue filter searches queue names as you type and lists the first 20 matches, with a note when more match. The state filter starts on unfinished (created, retry and active), and also offers all states or any single state. The advanced filters match on keys inside the job's `data` or `output` JSON. The list shows the newest created jobs first, or the newest finished first when you filter by completed, cancelled or failed. **Manage view** adds custom columns from job fields (for example `data.tenantId`). **Copy link** copies a URL with the current filters and columns. Clicking a job opens its detail page.

![Jobs page](./images/dashboard-jobs.webp){.light-only}
![Jobs page](./images/dashboard-jobs-dark.webp){.dark-only}

### Job detail

One job: its state, the reason it's waiting or stopped, and its data and output. A failed job leads with its error and the attempt it failed on. A sidebar beside the error shows the job's timeline, retries and configuration. A running job shows how long it has been running, its heartbeat, and a countdown to its expiration. The page picks up a new state without a reload. A completed job opens on its output.

![A failed job's page](./images/dashboard-job.webp){.light-only}
![A failed job's page](./images/dashboard-job-dark.webp){.dark-only}

The timeline shows the times the job's row keeps. Earlier attempts appear only as a count, because a retry overwrites the start time and output. The last entry is when [retention](./api/queues.md#createqueue-name-queue) deletes the job, which is `deleteAfterSeconds` after it finished, or at `keepUntil` if it never ran.

#### Job actions

A failed job has **Retry job**, a cancelled job has **Resume job**, and a job that hasn't finished has **Cancel job**, which asks first. Each calls pg-boss's own [`retry()`, `cancel()` or `resume()`](./api/jobs.md) on that one job. Anyone who can open the dashboard can make these changes. The dashboard doesn't record who made them.

The dashboard's copy of `pg-boss` must be on the database's schema version, because pg-boss makes the change. On any other version, pages still read. A refused change shows the reason on the page. Set `PGBOSS_DASHBOARD_READ_ONLY=true` to hide the buttons and refuse every change.

A job copied into a dead letter queue shows the reason it's there (taken from the original job's output) and a lineage chain from the first job to this job. The job records only the first job (the root) and the job it was copied from (the source). Any hops between them show as a gap. Select the root or the source to see that job's timeline. The dashboard reads the timeline from that job's row while the row still exists, or from what was copied onto this job after the row is deleted. A root redriven into a different queue shows as not found, because the dashboard looks up the root in the queue a redrive returns jobs to.

### Queues

Every queue in the schema with its policy and cached counts (queued, deferred, ready, active, failed, total), a trend sparkline and storage mode (shared or partitioned). pg-boss's own queues, such as `__pgboss__send-it` for cron, are left out. Sort by any column but the trend, search by name, or show only the queues needing attention or the partitioned queues. Clicking a queue opens its detail page. The detail page shows the queue's counts in one card, as the overview does. The ready count and a sparkline sit above the rest of what's queued. Next, the queue's newest 10 jobs in the chosen state sit beside the queue's settings. **View all** opens the [Jobs](#jobs) page filtered to the queue and that state. The page marks a queue that other queues send failed jobs to as a dead letter queue. **View metrics** and each of the page's counts open the queue's [metrics page](#queue-metrics).

![Queues page](./images/dashboard-queues.webp){.light-only}
![Queues page](./images/dashboard-queues-dark.webp){.dark-only}

![A queue's page](./images/dashboard-queue.webp){.light-only}
![A queue's page](./images/dashboard-queue-dark.webp){.dark-only}

### Queue metrics

One queue's counts over time. Two charts plot what pg-boss records in `queue_stats`:

- **Waiting**: every job not started yet, stacked by why it waits (ready, blocked by a flow parent, or deferred). Together they are the queue's queued count. Blocked is queued less ready and deferred. Computing it needs nothing more from pg-boss.
- **Active and failed**: jobs being worked, and failures still stored. **Show total stored** adds every job the queue holds.

Choose whether each point is the highest, lowest or average of the samples in its bucket. Pick a range from the last hour to the last 30 days (24 hours by default), or set your own start and end. The queue page's counts open this page at the chart that holds them.

![A queue's metrics page](./images/dashboard-queue-metrics.webp){.light-only}
![A queue's metrics page](./images/dashboard-queue-metrics-dark.webp){.dark-only}

**Requirements.** The chart needs [`persistQueueStats: true`](./api/constructor.md#persistqueuestats) on the pg-boss instances that run the monitor. Without it `queue_stats` stays empty and the page says so. See [Empty queue metrics](#empty-queue-metrics).

### Schedules

Schedules registered with `boss.schedule()`. The list shows the target queue, optional key, expression, a human-readable frequency, the next occurrence and timezone. The dashboard reads both schedule kinds through pg-boss itself. It badges a schedule stored as an [RRULE](./api/scheduling.md#rrule-expressions) and shows the same next occurrence the scheduling pass will use. Each schedule's detail page shows its data, options and the last job it created.

![Schedules page](./images/dashboard-schedules.webp){.light-only}
![Schedules page](./images/dashboard-schedules-dark.webp){.dark-only}

### Subscriptions

Events registered with [`boss.subscribe()`](./api/pubsub.md). Each row is an event with every queue subscribed to it. Sort by event, queue count or the time a queue last subscribed. A queue's page shows how many events it is subscribed to and links to this page filtered to those events.

![Subscriptions page](./images/dashboard-subscriptions.webp){.light-only}
![Subscriptions page](./images/dashboard-subscriptions-dark.webp){.dark-only}

### Instances

Every pg-boss instance registered in the database's [instance registry](./api/ops.md#getinstances-options). Each row shows an instance's status (live, quiet or stopped), the pg-boss version it runs, which of `supervise` and `schedule` it has on, and the queues it works. Filter by status, or by **Recent** for the instances that started, stopped or went quiet in the last 24 hours. An instance's page shows its pool, CPU, memory and event loop at its last heartbeat against the limits it read. Its workers and options follow, with non-default options listed first. Beside those cards, a process card shows the instance's id, connection name, start and last heartbeat, the connections Postgres has open under that name now, and any crash restarts (instances with the same name on the same host that ended without `stop()` in a row before this instance started). The registry needs pg-boss 12.36 or later (schema 44). On an older schema the page says so.

Three tiles sit above the list:

- **Live** counts the live instances and their hosts, and how many went quiet or stopped cleanly in the last 24 hours.
- **Database connections** counts the server's connections out of `max_connections` and separates pg-boss's connections from other applications'.
- **Versions and options** lists the pg-boss versions live and which live instances have `supervise` and `schedule` on.

![Instances page](./images/dashboard-instances.webp){.light-only}
![Instances page](./images/dashboard-instances-dark.webp){.dark-only}

### Migrations

Status of boss async migrations (BAM), the schema changes such as concurrent index builds that pg-boss runs outside the install transaction. The page lists each command's version, target table and status, and filters by status. Each command's page shows the SQL that was (or will be) executed, any error message, and the times the command was queued, started and ended.

![Migrations page](./images/dashboard-migrations.webp){.light-only}
![Migrations page](./images/dashboard-migrations-dark.webp){.dark-only}

### Warnings

Every warning pg-boss emitted while [`persistWarnings`](#enabling-warning-persistence) was enabled, newest first. Examples are slow queries, queue backlogs and clock skew. Each entry shows its type, message, key details (for example the queue and its size, or the query duration) and time. You can filter the list by warning type. Each entry's page shows its full message, its queue and every detail it recorded.

![Warnings page](./images/dashboard-warnings.webp){.light-only}
![Warnings page](./images/dashboard-warnings-dark.webp){.dark-only}

## Requirements

- Node.js 22.12+
- PostgreSQL database with pg-boss schema
- A database on pg-boss schema version 32 or later, which is pg-boss 12.21 (see below)

### Matching pg-boss versions

Dashboard 2.x reads a database on pg-boss schema version 32 or later (pg-boss 12.21 or later). Its version doesn't have to match the pg-boss your application runs. 2.0 has been run against every schema from 32 to 46 (pg-boss 12.38). Pages show the data a newer schema stores, such as the count of jobs blocked by a flow parent from schema 44, and leave that data out on an older schema.

The dashboard does not migrate your schema. It doesn't appear in [`getInstances()`](./api/ops.md#getinstances-options), because it starts no pg-boss instance of its own.

Releases before 2.0 were each built for one schema version and only work against a database on that version. Opening a job on another version fails with `pg-boss database requires migrations`:

| Dashboard | pg-boss | Schema version |
| - | - | - |
| 1.13.x | 12.38.x | 46 |
| 1.12.x | 12.38.x | 46 |
| 1.11.x | 12.37.x | 45 |
| 1.10.x | 12.35.x | 43 |
| 1.9.x | 12.33.x to 12.34.x | 42 |
| 1.8.x | 12.31.x to 12.32.x | 41 |
| 1.7.x | 12.30.x | 40 |

No 1.x release matches pg-boss 12.36.x (schema 44). 2.x reads schema 44.

## Installation

```bash
npm install @pg-boss/dashboard
```

## Quick start

To try the dashboard against a local database, run it with npx:

```bash
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx @pg-boss/dashboard
```

Open `http://localhost:3000` in your browser.

## Configuration

Configure the dashboard with environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string(s) | `postgres://localhost/pgboss` |
| `PGBOSS_SCHEMA` | pg-boss schema name(s) | `pgboss` |
| `PORT` | Server port | `3000` |
| `HOST` | Interface to listen on | `0.0.0.0` |
| `PGBOSS_DASHBOARD_AUTH_USERNAME` | Basic auth username (optional) | - |
| `PGBOSS_DASHBOARD_AUTH_PASSWORD` | Basic auth password (optional) | - |
| `PGBOSS_DASHBOARD_BASE_PATH` | Sub-path to serve the dashboard under, e.g. `/pgboss` (see [Serving under a sub-path](#serving-under-a-sub-path)) | `/` |
| `PGBOSS_DASHBOARD_READ_ONLY` | `true` or `1` turns off retry, cancel and resume on a job's page (see [Job actions](#job-actions)) | - |
| `PGBOSS_DASHBOARD_QUERY_TIMEOUT` | Max milliseconds per dashboard query before server-side cancellation (`statement_timeout`). `0` leaves the timeout to the database (see [Connection poolers](#connection-poolers)). Requires a restart to change. | `60000` |
| `PGBOSS_DASHBOARD_SITE_URL` | The public URL the dashboard is served at, as `https://host[:port]`. Needed behind a proxy that ends HTTPS (see [Reverse proxy](#reverse-proxy)) | - |

### Basic authentication

To protect the dashboard with basic authentication, set `PGBOSS_DASHBOARD_AUTH_USERNAME` and `PGBOSS_DASHBOARD_AUTH_PASSWORD`:

```bash
PGBOSS_DASHBOARD_AUTH_USERNAME=admin \
PGBOSS_DASHBOARD_AUTH_PASSWORD=secret \
DATABASE_URL="postgres://localhost/mydb" \
npx @pg-boss/dashboard
```

Set both variables or neither. If only one is set, the dashboard throws an error on startup.

### Multi-database configuration

To monitor multiple pg-boss instances, separate connection strings with a pipe (`|`):

```bash
DATABASE_URL="postgres://host1/db1|postgres://host2/db2" npx @pg-boss/dashboard
```

You can name each database so you can tell them apart in the UI:

```bash
DATABASE_URL="Production=postgres://prod/db|Staging=postgres://stage/db" npx @pg-boss/dashboard
```

If your databases use different schemas, list them in the same order, separated by pipes:

```bash
DATABASE_URL="postgres://host1/db1|postgres://host2/db2" \
PGBOSS_SCHEMA="pgboss|jobs" \
npx @pg-boss/dashboard
```

Two unnamed entries for the same database, such as one database under two schemas, would share a name. The later entry shows its schema, as in `app (jobs)`. Name each entry to choose what shows instead.

The top bar on every page starts with the name of the database being shown, and a colored dot that marks its place in the configuration. When you configure more than one database, the name opens a menu to switch between them. Switching keeps you on the same page. From a page about one item, such as a queue or a job, switching opens the list that page sits under instead (Queues, for both), since the other database may not have that item. A shared link opens the same database, because the URL's `db` query parameter holds the selected database (a URL without it opens the first database).

## Production deployment

### Option 1: Direct Node.js

```bash
npm install @pg-boss/dashboard

DATABASE_URL="postgres://user:pass@localhost:5432/db" \
  node node_modules/@pg-boss/dashboard/build/server.js
```

### Option 2: Docker

```dockerfile
FROM node:24
WORKDIR /app
RUN npm install -g @pg-boss/dashboard
ENV PORT=3000
EXPOSE 3000
CMD ["pg-boss-dashboard"]
```

```bash
docker build -t pgboss-dashboard .
docker run -d \
  -e DATABASE_URL="postgres://user:pass@host:5432/db" \
  -p 3000:3000 \
  pgboss-dashboard
```

### Option 3: Docker Compose

```yaml
services:
  dashboard:
    image: node:24
    working_dir: /app
    command: sh -c "npm install -g @pg-boss/dashboard && exec pg-boss-dashboard"
    environment:
      DATABASE_URL: postgres://user:pass@db:5432/mydb
      PGBOSS_SCHEMA: pgboss
      PORT: 3000
    ports:
      - "3000:3000"
    depends_on:
      - db
```

### Reverse proxy

For production, place a reverse proxy in front of any of the above options. This Nginx configuration accepts HTTPS and forwards plain HTTP to the dashboard:

```nginx
server {
    listen 443 ssl;
    server_name pgboss.example.com;
    ssl_certificate /etc/ssl/certs/pgboss.example.com.pem;
    ssl_certificate_key /etc/ssl/private/pgboss.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

Behind this proxy, pages load but every action fails with a 400 until you set the site URL. The browser sends `Origin: https://pgboss.example.com`. The dashboard sees a request for `http://pgboss.example.com`, because the proxy forwards plain HTTP. React Router rejects the action because the two origins differ. A proxy that rewrites `Host` causes the same 400 through a host mismatch. Set `PGBOSS_DASHBOARD_SITE_URL` to the URL your browser uses:

```bash
PGBOSS_DASHBOARD_SITE_URL=https://pgboss.example.com npx @pg-boss/dashboard
```

Every request then takes this scheme and host so that actions and redirects match what the browser sees. Give the origin only. A sub-path goes in `PGBOSS_DASHBOARD_BASE_PATH`. The dashboard stops at startup on a value with a path, a query or credentials.

While `PGBOSS_DASHBOARD_SITE_URL` is set, actions work only from that site. Unset it to use the dashboard directly, for example at `http://localhost:3000`.

### Connection poolers

The dashboard applies the `PGBOSS_DASHBOARD_QUERY_TIMEOUT` value with `SET statement_timeout` when it opens each connection. Behind a transaction pooler, such as PgBouncer in transaction mode or Supavisor on port 6543, the setting stays on the server connection after the dashboard's statement ends. A pg-boss worker or any other client that runs on that server connection later keeps the dashboard's timeout, which is 60 seconds by default. The server cancels any statement of that client's that takes longer.

Set `PGBOSS_DASHBOARD_QUERY_TIMEOUT=0` to keep the dashboard from setting a timeout. The database's own `statement_timeout` then applies. The dashboard waits for each query until the database ends it. To bound the dashboard's queries from the database, give the dashboard its own role and set the timeout on that role:

```sql
ALTER ROLE pgboss_dashboard SET statement_timeout = '60s';
```

Postgres applies a role's setting only to that role's sessions. A pooler keeps separate server connections for each role.

Behind RDS Proxy, the `SET` pins each dashboard connection to one database connection. The dashboard's pool holds at most 10 connections and closes idle ones.

### Serving under a sub-path

By default the dashboard serves from the root path (`/`). To serve it under a sub-path (for example behind a reverse proxy at `https://example.com/pgboss/`), set `PGBOSS_DASHBOARD_BASE_PATH` when you start it:

```bash
PGBOSS_DASHBOARD_BASE_PATH=/pgboss npx @pg-boss/dashboard
```

Assets, in-app navigation, and action redirects all stay under the prefix. The published npm package needs no rebuild, because the base path is a runtime setting. Have the reverse proxy forward the prefix unchanged, without stripping it. Match `/pgboss` with no trailing slash, because the home page fetches its data at `/pgboss.data`.

```nginx
location /pgboss {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
```

> Setting `PGBOSS_DASHBOARD_BASE_PATH` at build time also works and bakes the prefix into the build. A value set at runtime takes precedence.

> The dev server (`npm run dev`) serves its pages under `PGBOSS_DASHBOARD_BASE_PATH` too, but its assets stay at the root path. Test a reverse proxy against the built dashboard.

### Mounting inside an existing application

If you already run a Node.js server, you can mount the dashboard in it instead of running a separate process. `createDashboardHandler()` returns a standard [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) handler, `(request: Request) => Promise<Response>`.

A framework built on `Request`/`Response`, such as Hono, passes requests straight to the handler:

```ts
import { Hono } from 'hono'
import { createDashboardHandler } from '@pg-boss/dashboard/handler'

const dashboard = createDashboardHandler({
  databases: [{ url: process.env.DATABASE_URL!, schema: 'pgboss' }],
  basePath: '/admin/queues',
})

const app = new Hono()

app.use('/admin/*', requireAdmin) // your own authentication middleware
app.all('/admin/queues', (c) => dashboard(c.req.raw))
app.all('/admin/queues.data', (c) => dashboard(c.req.raw)) // the home page's data request
app.all('/admin/queues/*', (c) => dashboard(c.req.raw))
```

With Express, Fastify or plain `node:http`, convert the request first. `@hono/node-server` ships an adapter that does the conversion:

```ts
import express from 'express'
import { getRequestListener } from '@hono/node-server'

const app = express()

app.use(['/admin/queues', '/admin/queues.data'], requireAdmin, (req, res) => {
  req.url = req.originalUrl // Express strips the mount path; the handler needs it
  return getRequestListener(dashboard)(req, res)
})
```

| Option | Description |
|--------|-------------|
| `databases` | One or more `{ url, name?, schema? }` entries. The first is selected by default. Give each a distinct `name` when two connection strings end in the same database name. |
| `basePath` | The path you mount the handler under. Requests must reach the handler with this prefix still in the URL. Defaults to `/`. |
| `siteUrl` | The public URL the dashboard is served at, as `https://host[:port]`. Needed behind a proxy (see below). |
| `auth` | Puts the `PGBOSS_DASHBOARD_AUTH_*` Basic credential in front of the mounted dashboard. Defaults to `false`, because the host app normally handles authentication. |

When you mount the handler:

- **Authentication is yours.** The handler adds none of its own. Without a guard in front of the handler, any visitor can read job payloads. Place the handler behind whatever already protects your admin routes.
- **It's lazy.** The handler imports nothing and opens no database connection until the first request arrives. Its connection pool drains again when the dashboard is idle.
- **It doesn't depend on the working directory.** It resolves static assets relative to the installed package.
- **Route the home page's data request too.** React Router fetches it at `<basePath>.data`, which sits beside the mount path instead of under it. With only a `/admin/queues/*` pattern, the Home link shows a 404 because the pattern misses that request. Anything else outside the base path gets a plain 404 from the handler.
- **Call `close()` when your server shuts down.** The standalone server exits on `SIGTERM`/`SIGINT`. The handler leaves signals to you. `await dashboard.close()` ends its database pools. A closed handler answers 503.
- **Behind a reverse proxy, pass the public URL.** React Router rejects a form submission whose `Origin` doesn't match the request URL. When your server sees an internal address such as `http://127.0.0.1:3000`, pages render but every action fails with a 400. Pass `siteUrl: 'https://admin.example.com'`, which works like [`PGBOSS_DASHBOARD_SITE_URL`](#reverse-proxy), or pass the handler a `Request` with the public URL.
- **Environment variables.** `PGBOSS_DASHBOARD_QUERY_TIMEOUT` and `PGBOSS_DASHBOARD_READ_ONLY` apply. `DATABASE_URL`, `PGBOSS_SCHEMA`, `PORT`, `HOST`, `PGBOSS_DASHBOARD_BASE_PATH` and `PGBOSS_DASHBOARD_SITE_URL` don't, because the options replace them. `PGBOSS_DASHBOARD_AUTH_*` is off unless you pass `auth: true`. If `PGBOSS_DASHBOARD_AUTH_*` or `PGBOSS_DASHBOARD_SITE_URL` is set while the matching option is off, the dashboard says so when you construct the handler.

## Enabling warning persistence

To capture warnings in the dashboard, enable warning persistence in your pg-boss configuration:

```javascript
const { PgBoss } = require('pg-boss');

const boss = new PgBoss({
  connectionString: 'postgres://localhost/mydb',
  persistWarnings: true  // Enable warning persistence
});
```

Each warning matches a [`warning`](./api/events.md#warning) event that pg-boss emits:
- `slow_query`: Queries taking longer than expected
- `queue_backlog`: Queues exceeding their warning threshold
- `clock_skew`: Database clock drift detection
- `listen_notify_unavailable`: `useListenNotify` is on but no listener could be established
- `invalid_schedule`: A stored schedule could not be evaluated and was skipped
- `index_bloat`: A job index holds far more pages than its live entries need and was not rebuilt
- `xmin_horizon`: Vacuum reclaims nothing because something is pinning the MVCC horizon
- `autovacuum_disabled`: Nothing is vacuuming a job table at all
- `monitor_backoff`: The queue-stats aggregate was deferred to keep autovacuum moving
- `handler_overrun`: A `work()` handler ran past `expireInSeconds` and was still running after its batch failed

The dashboard shows a warning type written by a newer pg-boss core under its raw name.

## Tech stack

- **Framework**: [React Router 8](https://reactrouter.com/) (framework mode)
- **Server**: [Hono](https://hono.dev/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Components**: [Base UI](https://base-ui.com/)
- **Database**: [pg](https://node-postgres.com/) (PostgreSQL client)
- **Testing**: [Vitest](https://vitest.dev/) + [Testing Library](https://testing-library.com/)

## Troubleshooting

### "Error loading dashboard"

- Check that `DATABASE_URL` is correct and the database is reachable
- Check PostgreSQL logs for connection errors

### "pg-boss isn't installed in this database"

The database has no pg-boss schema with the name in `PGBOSS_SCHEMA` (`pgboss` by default). The application's pg-boss creates the schema when it first starts. The [CLI](./cli.md) can also create it ahead of time. The dashboard doesn't install pg-boss.

### Missing warnings

- Ensure `persistWarnings: true` is set in your pg-boss configuration
- pg-boss records warnings only after you turn this option on

### Stale queue stats

pg-boss's monitor caches queue statistics in the `queue` table. They update every [`monitorIntervalSeconds`](./api/constructor.md#monitorintervalseconds), which defaults to 60 seconds.

### Empty queue metrics

- Ensure `persistQueueStats: true` is set on the pg-boss instances that run the monitor. Without it `queue_stats` stays empty. The queue and metrics pages then show a banner saying so.
- History starts with the first monitor pass after the option is turned on. A range that reaches back before then is empty for that stretch.

## Contributing

To work on the dashboard from source, see the [package README](https://github.com/timgit/pg-boss/blob/master/packages/dashboard/README.md#development).
