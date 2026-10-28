# Dashboard

The [`@pg-boss/dashboard`](https://www.npmjs.com/package/@pg-boss/dashboard) package is a web dashboard for monitoring jobs, queues and schedules. It's read-only, and shows what pg-boss is doing without changing anything. To send, retry, cancel, resume or delete jobs, or to create queues and schedules, use the pg-boss API or the Pro Console in [pg-boss Pro](./pro/index.md). Pro adds those changes, allowed by role, to this dashboard, along with alerts, accounts and an audit log.

![A queue's waiting jobs over the last 24 hours](./images/dashboard-queue-waiting.webp){.light-only}
![A queue's waiting jobs over the last 24 hours](./images/dashboard-queue-waiting-dark.webp){.dark-only}

## Features

- **Overview**: Aggregate statistics, problem queues, and recent warnings
- **Queues**: View all queues with cached statistics
- **Queue Metrics**: Chart a queue's counts over time from its recorded history
- **Subscriptions**: Each event and the queues subscribed to it
- **Instances**: The pg-boss instances registered in the database, with their workers and options
- **Job List**: View jobs with state and queue filtering
- **Job Details**: View full job payloads, output data, and metadata
- **Warning History**: Browse the warnings pg-boss emitted earlier, when `persistWarnings` is enabled
- **Multi-Schema Support**: Monitor multiple pg-boss instances from a single dashboard
- **Mobile Responsive**: Full functionality on mobile devices with collapsible sidebar
- **Shareable URLs**: The URL keeps the selected database and filters, so you can share it

## Pages

### Overview

The landing page has one row of figures across all queues: jobs ready to run (with how many are queued in all, deferred or blocked), active, failed, and stored in total (with how many of those have completed or been canceled). Below it are the top queues by backlog, each with a ready-count trend sparkline and a status badge, and the most recent warnings. The badge reads backlogged when the queue holds more queued jobs than its `warningQueueSize`, processing when it has active jobs, ready when it has ready jobs and none active, and idle otherwise.

![Overview page](./images/dashboard-overview.webp){.light-only}
![Overview page](./images/dashboard-overview-dark.webp){.dark-only}

### Jobs

Recently created jobs across all queues. Filter by job ID, queue, state and minimum retry count. The state filter starts on unfinished (created, retry and active), and also offers all states or any single one. The advanced filters match on keys inside the job's `data` or `output` JSON. The list shows the newest created jobs first, or the newest finished first when you filter by completed, canceled or failed. **Manage view** adds custom columns from job fields (for example `data.tenantId`), and **Copy link** copies a URL with the current filters and columns. Clicking a job opens its detail page.

![Jobs page](./images/dashboard-jobs.webp){.light-only}
![Jobs page](./images/dashboard-jobs-dark.webp){.dark-only}

### Job detail

One job: its state, what it's waiting for or why it stopped, and its data and output. A failed job leads with its error and the attempt it failed on. A running job shows how long it has been running, its heartbeat, and a countdown to its expiration, and the page picks up a new state without a reload. A completed job opens on its output.

![A failed job's page](./images/dashboard-job.webp){.light-only}
![A failed job's page](./images/dashboard-job-dark.webp){.dark-only}

The timeline shows the times the job's row keeps. A retry overwrites the start time and output, so earlier attempts appear only as a count. The last entry is when [retention](./api/queues.md#createqueue-name-queue) deletes the job, which is `deleteAfterSeconds` after it finished, or at `keepUntil` if it never ran.

A job copied into a dead letter queue shows why it's there, from the original job's output, and a lineage chain from the first job to this one. The job records only the first job (the root) and the job it was copied from (the source), so any hops between them show as a gap. Select either to see its timeline, taken from its own row while it still exists, or from what was copied onto this job once it has been deleted. The dashboard looks up the root in the queue a redrive returns jobs to, so a root redriven into a different queue shows as not found.

### Queues

Every queue in the schema with its policy and cached counts (queued, deferred, ready, active, failed, total), a trend sparkline and storage mode (shared or partitioned). pg-boss's own queues, such as `__pgboss__send-it` for cron, are left out. You can sort any column and search the list by name. Clicking a queue opens its detail page. It shows the queue's counts in one card, as on the overview, with the ready count and a sparkline above the rest of what's queued. Its jobs come next, with its settings beside them. The page marks a queue that other queues send failed jobs to as a dead letter queue. **View metrics**, or any of the page's counts, opens the queue's [metrics page](#queue-metrics).

![Queues page](./images/dashboard-queues.webp){.light-only}
![Queues page](./images/dashboard-queues-dark.webp){.dark-only}

![A queue's page](./images/dashboard-queue.webp){.light-only}
![A queue's page](./images/dashboard-queue-dark.webp){.dark-only}

### Queue metrics

One queue's counts over time (`/queues/:name/metrics`), charted from what pg-boss records in `queue_stats`, in two charts:

- **Waiting**: every job not started yet, stacked by why it waits (ready, blocked by a flow parent, or deferred). Together they are the queue's queued count. Blocked is queued less ready and deferred, so it needs nothing more from pg-boss.
- **Active and failed**: jobs being worked, and failures still stored. **Show total stored** adds every job the queue holds.

Choose whether each point is the highest, lowest or average of the samples in its bucket. The range runs from the last hour to the last 30 days (24 hours by default), or set your own start and end. The queue page's counts open this page at the chart that holds them.

![A queue's metrics page](./images/dashboard-queue-metrics.webp){.light-only}
![A queue's metrics page](./images/dashboard-queue-metrics-dark.webp){.dark-only}

**Requirements.** The chart needs [`persistQueueStats: true`](./api/constructor.md#persistqueuestats) on the pg-boss instances that run the monitor. Without it `queue_stats` stays empty and the page says so. See [Queue metrics are empty](#queue-metrics-are-empty).

### Schedules

Schedules registered with `boss.schedule()`, showing the target queue, optional key, expression, a human-readable frequency, the next occurrence and timezone. The dashboard reads both schedule kinds through pg-boss itself, so it badges a schedule stored as an [RRULE](./api/scheduling.md#rrule-expressions) and shows the same next occurrence the scheduling pass will use. Each schedule's detail page shows its data, options and the last job it created.

![Schedules page](./images/dashboard-schedules.webp){.light-only}
![Schedules page](./images/dashboard-schedules-dark.webp){.dark-only}

### Subscriptions

Events registered with [`boss.subscribe()`](./api/pubsub.md), one row per event with every queue subscribed to it, sortable by event, queue count or when a queue last subscribed. A queue's page shows how many events it is subscribed to and links here, filtered to those events.

![Subscriptions page](./images/dashboard-subscriptions.webp){.light-only}
![Subscriptions page](./images/dashboard-subscriptions-dark.webp){.dark-only}

### Instances

Every pg-boss instance registered in the database's [instance registry](./api/ops.md#getinstances-options), one row each, with its status (live, quiet or stopped), the pg-boss version it runs, which of `supervise` and `schedule` it has on, and the queues it works. Filter by status, or by **Recent** for the ones that started, stopped or went quiet in the last 24 hours. An instance's page shows its pool, CPU, memory and event loop at its last heartbeat, against the limits it read, then its workers and its options, with the non-default ones listed first. Beside them, its process card gives its id, connection name, start and last heartbeat, the connections Postgres has open under that name now, and any crash restarts (instances with its name on its host that ended without `stop()` in a row before it started). The registry needs pg-boss 12.36 (schema 44). On an older schema the page says so.

![Instances page](./images/dashboard-instances.webp){.light-only}
![Instances page](./images/dashboard-instances-dark.webp){.dark-only}

### Migrations

Status of boss async migrations (BAM), the schema changes such as concurrent index builds that pg-boss runs outside the install transaction. The page shows pending, in-progress, completed and failed counts, and each command's version, target table and status. A command opens a page with the SQL that was (or will be) executed, any error message, and when it was queued, started and ended.

![Migrations page](./images/dashboard-migrations.webp){.light-only}
![Migrations page](./images/dashboard-migrations-dark.webp){.dark-only}

### Warnings

Every warning pg-boss emitted while [`persistWarnings`](#enabling-warning-persistence) was enabled, such as slow queries, queue backlogs or clock skew, newest first. Each entry shows its type, message, key details (for example the queue and its size, or the query duration) and time. You can filter the list by warning type. An entry opens a page with its full message, its queue and every detail it recorded.

![Warnings page](./images/dashboard-warnings.webp){.light-only}
![Warnings page](./images/dashboard-warnings-dark.webp){.dark-only}

## Requirements

- Node.js 22.12+
- PostgreSQL database with pg-boss schema
- A database on pg-boss schema version 32 or later, which is pg-boss 12.21 (see below)

### Matching pg-boss versions

Dashboard 2.x reads a database on pg-boss schema version 32 or later (pg-boss 12.21 or later), so it doesn't have to match the pg-boss your application runs. 2.0 has been run against every schema from 32 to 46 (pg-boss 12.38). Pages show what a newer schema stores, such as the count of jobs blocked by a flow parent from schema 44, and leave it out on an older one.

The dashboard does not migrate your schema, and it starts no pg-boss instance of its own, so it never appears in [`getInstances()`](./api/ops.md#getinstances-options).

Releases before 2.0 were each built for one schema version and only work against a database on that version. Opening a job on another version fails with `pg-boss database requires migrations`:

| Dashboard | pg-boss | Schema version |
| - | - | - |
| 1.12.x | 12.38.x | 46 |
| 1.11.x | 12.37.x | 45 |
| 1.10.x | 12.35.x | 43 |
| 1.9.x | 12.33.x to 12.34.x | 42 |
| 1.8.x | 12.31.x to 12.32.x | 41 |
| 1.7.x | 12.30.x | 40 |

No 1.x release matches pg-boss 12.36.x (schema 44). 2.x reads it.

## Installation

```bash
npm install @pg-boss/dashboard
```

## Quick start

For a quick local test:

```bash
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-dashboard
```

Open `http://localhost:3000` in your browser.

## Configuration

Configure the dashboard with environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string(s) | `postgres://localhost/pgboss` |
| `PGBOSS_SCHEMA` | pg-boss schema name(s) | `pgboss` |
| `PORT` | Server port | `3000` |
| `PGBOSS_DASHBOARD_AUTH_USERNAME` | Basic auth username (optional) | - |
| `PGBOSS_DASHBOARD_AUTH_PASSWORD` | Basic auth password (optional) | - |
| `PGBOSS_DASHBOARD_BASE_PATH` | Sub-path to serve the dashboard under, e.g. `/pgboss` (see [Serving under a sub-path](#serving-under-a-sub-path)) | `/` |
| `PGBOSS_DASHBOARD_QUERY_TIMEOUT` | Max milliseconds per dashboard query before server-side cancellation (`statement_timeout`). Requires a restart to change. | `60000` |
| `PGBOSS_DASHBOARD_SITE_URL` | The public URL the dashboard is served at, as `https://host[:port]`. Needed behind a proxy that ends HTTPS (see [Reverse proxy](#reverse-proxy)) | - |

### Basic authentication

To protect the dashboard with basic authentication, set `PGBOSS_DASHBOARD_AUTH_USERNAME` and `PGBOSS_DASHBOARD_AUTH_PASSWORD`:

```bash
PGBOSS_DASHBOARD_AUTH_USERNAME=admin \
PGBOSS_DASHBOARD_AUTH_PASSWORD=secret \
DATABASE_URL="postgres://localhost/mydb" \
npx pg-boss-dashboard
```

Set both variables or neither. If only one is set, the dashboard throws an error on startup.

### Multi-database configuration

To monitor multiple pg-boss instances, separate connection strings with a pipe (`|`):

```bash
DATABASE_URL="postgres://host1/db1|postgres://host2/db2" npx pg-boss-dashboard
```

You can name each database so you can tell them apart in the UI:

```bash
DATABASE_URL="Production=postgres://prod/db|Staging=postgres://stage/db" npx pg-boss-dashboard
```

If your databases use different schemas, list them in the same order, separated by pipes:

```bash
DATABASE_URL="postgres://host1/db1|postgres://host2/db2" \
PGBOSS_SCHEMA="pgboss|jobs" \
npx pg-boss-dashboard
```

The top bar on every page starts with the name of the database being shown, and a colored dot that marks its place in the configuration. When you configure more than one database, the name opens a menu to switch between them, and switching keeps you on the same page. From a page about one item, such as a queue or a job, it opens the list that page sits under instead (Queues, for both), since the other database may not have that item. The URL's `db` query parameter holds the selected database (it's left out for the first database), so a shared link opens the same database.

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
    command: sh -c "npm install -g @pg-boss/dashboard && pg-boss-dashboard"
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

For production, place a reverse proxy in front of any of the above options. Example Nginx configuration:

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

Behind this proxy, pages load but every action fails with a 400 until you set the site URL. The browser sends `Origin: https://pgboss.example.com`. The proxy forwards plain HTTP, so the dashboard sees a request for `http://pgboss.example.com`, and React Router rejects the action because the two origins differ. A proxy that rewrites `Host` causes the same 400 through a host mismatch. Set `PGBOSS_DASHBOARD_SITE_URL` to the URL your browser uses:

```bash
PGBOSS_DASHBOARD_SITE_URL=https://pgboss.example.com npx pg-boss-dashboard
```

Every request then takes this scheme and host, so actions and redirects match what the browser sees. Give the origin only. A sub-path goes in `PGBOSS_DASHBOARD_BASE_PATH`. The dashboard stops at startup on a value with a path, a query or credentials.

While it's set, actions work only from that site. Unset it to use the dashboard directly, for example at `http://localhost:3000`.

### Serving under a sub-path

By default the dashboard serves from the root path (`/`). To serve it under a sub-path (for example behind a reverse proxy at `https://example.com/pgboss/`), set `PGBOSS_DASHBOARD_BASE_PATH` when you start it:

```bash
PGBOSS_DASHBOARD_BASE_PATH=/pgboss npx pg-boss-dashboard
```

Assets, in-app navigation, and action redirects all stay under the prefix. It's a runtime setting, so it works with the published npm package as is, with no rebuild. Have the reverse proxy forward the prefix unchanged, without stripping it. Match `/pgboss` with no trailing slash, because the home page fetches its data at `/pgboss.data`.

```nginx
location /pgboss {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
```

> Setting `PGBOSS_DASHBOARD_BASE_PATH` at build time also works and bakes the prefix into the build. A value set at runtime takes precedence.

> The dev server (`npm run dev`) always serves from the root path.

### Mounting inside an existing application

If you already run a Node.js server, you can mount the dashboard in it instead of running a separate process. `createDashboardHandler()` returns a standard [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) handler, `(request: Request) => Promise<Response>`.

With a framework built on `Request`/`Response`, such as Hono, it plugs straight in:

```ts
import { Hono } from 'hono'
import { createDashboardHandler } from '@pg-boss/dashboard/handler'

const dashboard = createDashboardHandler({
  databases: [{ url: process.env.DATABASE_URL, schema: 'pgboss' }],
  basePath: '/admin/queues',
})

const app = new Hono()

app.use('/admin/*', requireAdmin) // your own authentication middleware
app.all('/admin/queues', (c) => dashboard(c.req.raw))
app.all('/admin/queues.data', (c) => dashboard(c.req.raw)) // the home page's data request
app.all('/admin/queues/*', (c) => dashboard(c.req.raw))
```

With Express, Fastify or plain `node:http`, convert the request first. `@hono/node-server` ships an adapter that does it:

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

- **Authentication is yours.** The handler adds none of its own. Mounted without a guard, any visitor can read job payloads. Place it behind whatever already protects your admin routes.
- **It's lazy.** The handler imports nothing and opens no database connection until the first request arrives. Its connection pool drains again when the dashboard is idle.
- **It doesn't depend on the working directory.** It resolves static assets relative to the installed package.
- **Route the home page's data request too.** React Router fetches it at `<basePath>.data`, which sits beside the mount path instead of under it. A `/admin/queues/*` pattern alone misses it, and the Home link shows a 404. Anything else outside the base path gets a plain 404 from the handler.
- **Call `close()` when your server shuts down.** The standalone server exits on `SIGTERM`/`SIGINT`. The handler leaves signals to you, and `await dashboard.close()` ends its database pools. A closed handler answers 503.
- **Behind a reverse proxy, pass the public URL.** React Router rejects a form submission whose `Origin` doesn't match the request URL. When your server sees an internal address such as `http://127.0.0.1:3000`, pages render but every action fails with a 400. Pass `siteUrl: 'https://admin.example.com'`, which works like [`PGBOSS_DASHBOARD_SITE_URL`](#reverse-proxy), or pass the handler a `Request` with the public URL.
- **Environment variables.** `PGBOSS_DASHBOARD_QUERY_TIMEOUT` applies. `DATABASE_URL`, `PGBOSS_SCHEMA`, `PORT`, `HOST`, `PGBOSS_DASHBOARD_BASE_PATH` and `PGBOSS_DASHBOARD_SITE_URL` don't, because the options replace them. `PGBOSS_DASHBOARD_AUTH_*` is off unless you pass `auth: true`. If it or `PGBOSS_DASHBOARD_SITE_URL` is set while its option is off, the dashboard says so when you construct the handler.

## Enabling warning persistence

To capture warnings in the dashboard, enable warning persistence in your pg-boss configuration:

```javascript
const PgBoss = require('pg-boss');

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
- `xmin_horizon`: Something is pinning the MVCC horizon, so vacuum reclaims nothing
- `autovacuum_disabled`: Nothing is vacuuming a job table at all
- `monitor_backoff`: The queue-stats aggregate was deferred to keep autovacuum moving

The dashboard shows a warning type written by a newer pg-boss core under its raw name.

## Tech stack

- **Framework**: [React Router 8](https://reactrouter.com/) (framework mode)
- **Server**: [Hono](https://hono.dev/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Components**: [Base UI](https://base-ui.com/)
- **Database**: [pg](https://node-postgres.com/) (PostgreSQL client)
- **Testing**: [Vitest](https://vitest.dev/) + [Testing Library](https://testing-library.com/)

## Troubleshooting

### "Failed to load dashboard"

- Check that `DATABASE_URL` is correct and the database is reachable
- Ensure the pg-boss schema exists (run pg-boss at least once to create it)
- Check PostgreSQL logs for connection errors

### No warnings showing

- Ensure `persistWarnings: true` is set in your pg-boss configuration
- pg-boss records warnings only after you turn this option on

### Queue stats seem stale

pg-boss's monitor caches queue statistics in the `queue` table. They update every [`monitorIntervalSeconds`](./api/constructor.md#monitorintervalseconds), which defaults to 60 seconds.

### Queue metrics are empty

- Ensure `persistQueueStats: true` is set on the pg-boss instances that run the monitor. Without it `queue_stats` stays empty, and the queue and metrics pages show a banner saying so.
- History starts with the first monitor pass after the option is turned on, so a range that reaches back before then is empty for that stretch.

## Contributing

To work on the dashboard from source, see the [package README](https://github.com/timgit/pg-boss/blob/master/packages/dashboard/README.md#development).
