# Dashboard

A web-based dashboard is available for monitoring and managing pg-boss job queues.

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
