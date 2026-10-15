# Dashboard

A web-based dashboard is available in the [`@pg-boss/dashboard`](https://www.npmjs.com/package/@pg-boss/dashboard) package for monitoring jobs, queues and schedules. It is read-only: it shows what pg-boss is doing and changes nothing. Send, retry, cancel, resume and delete jobs, and create queues and schedules, through the pg-boss API, or from the console with [pg-boss Pro](./pro/index.md), which adds those changes by role, alerts, accounts and an audit log to this dashboard.

## Features

- **Overview**: Aggregate statistics, problem queues, and recent warnings at a glance
- **Queues**: View all queues with cached statistics
- **Queue Metrics**: Chart a queue's counts over time from its recorded history
- **Subscriptions**: Each event and the queues subscribed to it
- **Instances**: The pg-boss instances registered in the database, with their workers and options
- **Job List**: View jobs with state and queue filtering
- **Job Details**: View full job payloads, output data, and metadata
- **Warning History**: When `persistWarnings` is enabled, browse through previously emitted warning events
- **Multi-Schema Support**: Monitor multiple pg-boss instances from a single dashboard
- **Mobile Responsive**: Full functionality on mobile devices with collapsible sidebar
- **Shareable URLs**: Database selection and filters are preserved in URLs for easy sharing

## Pages

### Overview

Landing page with one row of figures across all queues: jobs ready to run (with how many are queued in all, deferred or blocked), active, failed, and stored in total (with how many of those have completed or been canceled). Below it are the top queues by backlog with a ready-count trend sparkline and status badge, and the most recent warnings.

![Overview page](./images/dashboard-overview.webp){.light-only}
![Overview page](./images/dashboard-overview-dark.webp){.dark-only}

### Jobs

Recently created jobs across all queues. Filter by job ID, queue, state (pending, created, retry, active, completed, cancelled or failed) and minimum retry count, or open the advanced filters to match on keys inside the job's `data` or `output` JSON. Jobs list newest created first, or newest finished first with the completed, cancelled or failed filter. **Manage view** lets you add custom columns sourced from job fields (for example `data.tenantId`), and **Copy link** produces a shareable URL with the current filters and columns. Clicking a job opens its detail page.

![Jobs page](./images/dashboard-jobs.webp){.light-only}
![Jobs page](./images/dashboard-jobs-dark.webp){.dark-only}

### Job detail

One job: its state, what it's waiting for or why it stopped, and its data and output. A failed job leads with its error and the attempt it failed on. A running job shows how long it has been running, its heartbeat, and a countdown to its time limit, and the page picks up a new state without a reload. A completed job opens on its output.

The timeline shows the times the job's row keeps. A retry overwrites the start time and output, so earlier attempts appear only as a count. The last entry is when [retention](./api/queues.md#createqueue-name-queue) deletes the job: `deleteAfterSeconds` after it finished, or at `keepUntil` if it never ran.

A job copied into a dead letter queue shows why it's there, from the original job's output, and a lineage chain from the first job to this one. Only the first job (the root) and the job this one was copied from (the source) are recorded, so any hops between them show as a gap. Select either to see its timeline, taken from its own row while it still exists, or from what was copied onto this job once it has been deleted. The root is looked up in the queue a redrive returns jobs to, so a root redriven into a different queue is reported as not found.

### Queues

Every queue in the schema with its policy and cached counts (queued, deferred, ready, active, failed, total), a trend sparkline, storage mode (shared or partitioned) and a status badge (idle, processing or backlogged). Columns are sortable and the list can be searched by name. Clicking a queue opens its detail page with configuration, a 24-hour ready-count history and the jobs in that queue. **View metrics**, or any of the page's six counts, opens the queue's [metrics page](#queue-metrics).

![Queues page](./images/dashboard-queues.webp){.light-only}
![Queues page](./images/dashboard-queues-dark.webp){.dark-only}

### Queue metrics

One queue's counts over time (`/queues/:name/metrics`), charted from what pg-boss records in `queue_stats`. Ready and failed are drawn by default. Add active, queued, deferred and total from the series picker, and choose whether each point is the maximum, minimum or average of the samples it covers. The range runs from the last hour to the last 30 days (24 hours by default), or set your own start and end.

**Requirements.** The chart needs [`persistQueueStats: true`](./api/constructor.md#persistqueuestats) on the pg-boss instances that run the monitor. Without it `queue_stats` stays empty and the page says so. See [Queue metrics are empty](#queue-metrics-are-empty).

### Schedules

Schedules registered with `boss.schedule()`, showing the target queue, optional key, expression, a human-readable frequency, the next occurrence and timezone. Both schedule kinds are read through pg-boss itself, so a schedule stored as an [RRULE](./api/scheduling.md#rrule-expressions) is badged as one and gets the same next occurrence the scheduling pass will use. Each schedule's detail page shows its data, options and the last job it created.

![Schedules page](./images/dashboard-schedules.webp){.light-only}
![Schedules page](./images/dashboard-schedules-dark.webp){.dark-only}

### Subscriptions

Events registered with [`boss.subscribe()`](./api/pubsub.md), one row per event with every queue subscribed to it, sortable by event, queue count or when a queue last subscribed. A queue's page shows how many events it is subscribed to and links here, filtered to those events.

### Instances

Every pg-boss instance registered in the database's [instance registry](./api/ops.md#getinstances-options), one row each, with its status (live, quiet or stopped), the pg-boss version it runs, its roles and the queues it works. Filter by status, or by **Recent** for the ones that started, stopped or went quiet in the last 24 hours. An instance's page shows its workers, its process, and its options with the ones it changed from the defaults listed first. The registry needs pg-boss 12.36 (schema 44). On an older schema the page says so.

### Migrations

Status of background async migrations (BAM), the schema changes such as concurrent index builds that pg-boss runs outside the install transaction. Shows pending, in-progress, completed and failed counts, and each command's version, target table and status. A command opens a page with the SQL that was (or will be) executed, any error message, and when it was queued, started and ended.

![Migrations page](./images/dashboard-migrations.webp){.light-only}
![Migrations page](./images/dashboard-migrations-dark.webp){.dark-only}

### Warnings

Event log of warnings emitted by pg-boss when [`persistWarnings`](#enabling-warning-persistence) is enabled, such as slow queries, queue backlogs or clock skew. Each entry shows its type, message, key details (for example the queue and its size, or the query duration) and time, and the list can be filtered by warning type. An entry opens a page with its full message, its queue and every detail it recorded.

![Warnings page](./images/dashboard-warnings.webp){.light-only}
![Warnings page](./images/dashboard-warnings-dark.webp){.dark-only}

## Requirements

- Node.js 22.12+
- PostgreSQL database with pg-boss schema
- A database on pg-boss schema version 32 or later, which is pg-boss 12.21 (see below)

### Matching pg-boss versions

Dashboard 2.x reads a database on pg-boss schema version 32 or later, which is pg-boss 12.21 or later, so it does not have to match the pg-boss your application runs. 2.0 has been run against every schema from 32 to 46 (pg-boss 12.38). Pages show what a newer schema stores, such as the count of jobs blocked by a flow parent from schema 44, and leave it out on an older one.

The dashboard does not migrate your schema, and it starts no pg-boss instance of its own, so it never appears in [`getInstances()`](./api/ops.md#getinstances-options).

Releases before 2.0 were each built for one schema version and only work against a database on that version. Opening a job on another version fails with `pg-boss database requires migrations`:

| Dashboard | pg-boss | Schema version |
| - | - | - |
| 1.12.x | 12.38.x | 46 |
| 1.11.x | 12.37.x | 45 |
| 1.10.x | 12.35.x | 43 |
| 1.9.x | 12.33.x – 12.34.x | 42 |
| 1.8.x | 12.31.x – 12.32.x | 41 |
| 1.7.x | 12.30.x | 40 |

No 1.x release matches pg-boss 12.36.x (schema 44). 2.x reads it.

## Installation

```bash
npm install @pg-boss/dashboard
```

## Quick Start

For a quick local test:

```bash
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-dashboard
```

Open `http://localhost:3000` in your browser.

## Configuration

The dashboard is configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string(s) | `postgres://localhost/pgboss` |
| `PGBOSS_SCHEMA` | pg-boss schema name(s) | `pgboss` |
| `PORT` | Server port | `3000` |
| `PGBOSS_DASHBOARD_AUTH_USERNAME` | Basic auth username (optional) | - |
| `PGBOSS_DASHBOARD_AUTH_PASSWORD` | Basic auth password (optional) | - |
| `PGBOSS_DASHBOARD_BASE_PATH` | Sub-path to serve the dashboard under, e.g. `/pgboss` (see [Serving under a sub-path](#serving-under-a-sub-path)) | `/` |
| `PGBOSS_DASHBOARD_QUERY_TIMEOUT` | Max milliseconds per dashboard query before server-side cancellation (`statement_timeout`). Requires a restart to change. | `60000` |

### Basic Authentication

To protect the dashboard with basic authentication, set `PGBOSS_DASHBOARD_AUTH_USERNAME` and `PGBOSS_DASHBOARD_AUTH_PASSWORD`:

```bash
PGBOSS_DASHBOARD_AUTH_USERNAME=admin \
PGBOSS_DASHBOARD_AUTH_PASSWORD=secret \
DATABASE_URL="postgres://localhost/mydb" \
npx pg-boss-dashboard
```

Both variables must be provided together. If only one is set, the dashboard will throw an error on startup.

### Multi-Database Configuration

To monitor multiple pg-boss instances, separate connection strings with a pipe (`|`):

```bash
DATABASE_URL="postgres://host1/db1|postgres://host2/db2" npx pg-boss-dashboard
```

You can optionally name each database for better identification in the UI:

```bash
DATABASE_URL="Production=postgres://prod/db|Staging=postgres://stage/db" npx pg-boss-dashboard
```

If your databases use different schemas, specify them with matching pipe separation:

```bash
DATABASE_URL="postgres://host1/db1|postgres://host2/db2" \
PGBOSS_SCHEMA="pgboss|jobs" \
npx pg-boss-dashboard
```

The database being shown is named at the start of the top bar on every page, with a colored dot by its place in the configuration. When multiple databases are configured, it opens a menu to switch between them; the switch keeps the page you are on. The selected database is persisted in the URL via the `db` query parameter (left out for the first database), making it easy to share links to specific database views.

## Production Deployment

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

### Reverse Proxy

For production, place a reverse proxy in front of any of the above options. Example Nginx configuration:

```nginx
server {
    listen 80;
    server_name pgboss.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Serving under a sub-path

By default the dashboard is served from the root path (`/`). To serve it under a sub-path (for example behind a reverse proxy at `https://example.com/pgboss/`), set `PGBOSS_DASHBOARD_BASE_PATH` when you start it:

```bash
PGBOSS_DASHBOARD_BASE_PATH=/pgboss npx pg-boss-dashboard
```

Assets, in-app navigation, and action redirects all stay under the prefix. This is a runtime setting, so it works with the published npm package as is; no rebuild is needed. The reverse proxy should forward the prefix unchanged (do not strip it). Match `/pgboss` rather than `/pgboss/`: the home page fetches its data at `/pgboss.data`.

```nginx
location /pgboss {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> Setting `PGBOSS_DASHBOARD_BASE_PATH` at build time still works and bakes the prefix into the build. A value set at runtime takes precedence.

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
| `allowedActionOrigins` | Hosts a form may be submitted from, as `host[:port]` or `*.example.com`. Needed behind a proxy, see below. |
| `auth` | Put the `PGBOSS_DASHBOARD_AUTH_*` Basic credential in front of the mounted dashboard. Defaults to `false`, because the host is normally what authenticates. |

A few things worth knowing:

- **Authentication is yours.** The handler adds none of its own. Mounted without a guard, it lets anyone read job payloads. Place it behind whatever already protects your admin routes.
- **It is lazy.** Nothing is imported and no database connection is opened until the first request arrives. The connection pool drains again when the dashboard is idle.
- **It does not depend on the working directory.** Static assets are resolved relative to the installed package.
- **Route the home page's data request too.** React Router fetches it at `<basePath>.data`, a sibling of the mount path rather than a child, so a `/admin/queues/*` pattern alone misses it and the Home link shows a 404. Anything else outside the base path gets a plain 404 from the handler.
- **Call `close()` when your server shuts down.** The standalone server exits on `SIGTERM`/`SIGINT`; the handler leaves signals to you, and `await dashboard.close()` ends its database pools. A closed handler answers 503.
- **Behind a reverse proxy, list your public host.** React Router rejects a form submission whose `Origin` does not match the request URL. When your server sees an internal address such as `http://127.0.0.1:3000`, pages render but every action fails with a 400. Pass `allowedActionOrigins: ['admin.example.com']`.
- **Environment variables.** `PGBOSS_DASHBOARD_QUERY_TIMEOUT` applies. `DATABASE_URL`, `PGBOSS_SCHEMA`, `PORT`, `HOST` and `PGBOSS_DASHBOARD_BASE_PATH` do not: the options replace them. `PGBOSS_DASHBOARD_AUTH_*` is off unless you pass `auth: true`, and if it is set while `auth` is off the dashboard says so when you construct the handler rather than ignoring it quietly.

## Enabling Warning Persistence

To capture warnings in the dashboard, enable warning persistence in your pg-boss configuration:

```javascript
const PgBoss = require('pg-boss');

const boss = new PgBoss({
  connectionString: 'postgres://localhost/mydb',
  persistWarnings: true  // Enable warning persistence
});
```

Warnings correlate to [`warning`](./api/events.md#warning) events already emitted by pg-boss:
- `slow_query`: Queries taking longer than expected
- `queue_backlog`: Queues exceeding their warning threshold
- `clock_skew`: Database clock drift detection
- `listen_notify_unavailable`: `useListenNotify` is on but no listener could be established
- `invalid_schedule`: A stored schedule could not be evaluated and was skipped
- `index_bloat`: A job index holds far more pages than its live entries need and was not rebuilt
- `xmin_horizon`: Something is pinning the MVCC horizon, so vacuum reclaims nothing
- `autovacuum_disabled`: Nothing is vacuuming a job table at all
- `monitor_backoff`: The queue-stats aggregate was deferred to keep autovacuum moving

A warning type written by a newer pg-boss core than the dashboard is displayed under its raw name.

## Tech Stack

- **Framework**: [React Router 8](https://reactrouter.com/) (framework mode)
- **Server**: [Hono](https://hono.dev/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Components**: [Base UI](https://base-ui.com/)
- **Database**: [pg](https://node-postgres.com/) (PostgreSQL client)
- **Testing**: [Vitest](https://vitest.dev/) + [Testing Library](https://testing-library.com/)

## Troubleshooting

### "Failed to load dashboard"

- Verify `DATABASE_URL` is correct and the database is accessible
- Ensure the pg-boss schema exists (run pg-boss at least once to create it)
- Check PostgreSQL logs for connection errors

### No warnings showing

- Ensure `persistWarnings: true` is set in your pg-boss configuration
- Warnings are only recorded after enabling this option

### Queue stats seem stale

Queue statistics are cached in the `queue` table by pg-boss's monitoring system. They update based on your `monitorStateIntervalSeconds` configuration (default: 30 seconds).

### Queue metrics are empty

- Ensure `persistQueueStats: true` is set on the pg-boss instances that run the monitor. Without it `queue_stats` stays empty, and the queue and metrics pages show a banner saying so.
- History starts with the first monitor pass after the option is turned on, so a range that reaches back before then is empty for that stretch.

## Contributing

To work on the dashboard from source, see the [package README](https://github.com/timgit/pg-boss/blob/master/packages/dashboard/README.md#development).
