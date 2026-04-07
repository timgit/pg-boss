# Dashboard

A web-based dashboard is available in the [`@pg-boss/dashboard`](https://www.npmjs.com/package/@pg-boss/dashboard) package for monitoring and managing jobs, queues and schedules.

## Features

- **Overview Dashboard**: Aggregate statistics, problem queues, and recent warnings at a glance
- **Queue Management**: Browse all queues with real-time stats (queued, active, deferred, total)
- **Job Browser**: View and manage individual jobs with smart filtering (defaults to pending jobs)
- **Job Actions**: Create, cancel, retry, resume, or delete jobs directly from the UI
- **Warning History**: Track slow queries, queue backlogs, and clock skew issues
- **Multi-Database Support**: Monitor multiple pg-boss instances from a single dashboard

## Quick Start

```bash
npm install @pg-boss/dashboard
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-dashboard
```

Open http://localhost:3000 in your browser.

## Configuration

The dashboard is configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string(s) | `postgres://localhost/pgboss` |
| `PGBOSS_SCHEMA` | pg-boss schema name(s) | `pgboss` |
| `PORT` | Server port | `3000` |
| `PGBOSS_DASHBOARD_AUTH_USERNAME` | Basic auth username (optional) | - |
| `PGBOSS_DASHBOARD_AUTH_PASSWORD` | Basic auth password (optional) | - |

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

## Full Documentation

For complete documentation including production deployment options, page descriptions, job state reference, and troubleshooting, see the [full dashboard README](https://github.com/timgit/pg-boss/blob/master/packages/dashboard/README.md).
