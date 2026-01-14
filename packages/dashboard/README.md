# pg-boss Dashboard

A web-based dashboard for monitoring and managing [pg-boss](https://github.com/timgit/pg-boss) job queues.

## Features

- **Overview Dashboard**: Aggregate statistics, problem queues, and recent warnings at a glance
- **Queue Management**: Browse all queues with real-time stats (queued, active, deferred, total)
- **Job Browser**: View and manage individual jobs with filtering by state
- **Job Actions**: Cancel, retry, or delete jobs directly from the UI
- **Warning History**: Track slow queries, queue backlogs, and clock skew issues
- **Multi-Database Support**: Monitor multiple pg-boss instances from a single dashboard
- **Pagination**: Efficiently browse large datasets

## Requirements

- Node.js 18+
- PostgreSQL database with pg-boss schema
- pg-boss v10+ (uses the `queue` table for cached statistics)

## Installation

```bash
npm install @pg-boss/dashboard
```

## Quick Start

For a quick local test:

```bash
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

If your databases use different schemas, specify them with matching pipe separation:

```bash
DATABASE_URL="postgres://host1/db1|postgres://host2/db2" \
PGBOSS_SCHEMA="pgboss|jobs" \
npx pg-boss-dashboard
```

When multiple databases are configured, a database selector appears in the sidebar. The selected database is persisted in the URL via the `db` query parameter, making it easy to share links to specific database views.

## Production Deployment

### Option 1: Direct Node.js

```bash
npm install @pg-boss/dashboard

DATABASE_URL="postgres://user:pass@localhost:5432/db" \
  node node_modules/@pg-boss/dashboard/build/server/index.js
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

## Pages

### Dashboard (`/`)

The overview page displays:

- **Stats Cards**: Total queues, total jobs, active jobs, and failed jobs
- **Problem Queues**: Queues exceeding their `warningQueued` threshold
- **Recent Warnings**: Latest 5 warnings (requires `persistWarnings: true` in pg-boss config)
- **Queue Summary**: Table of first 10 queues with quick stats

### Queues List (`/queues`)

Paginated list of all queues showing:

- Queue name (links to detail page)
- Policy type (standard, short, singleton, stately)
- Job counts: Queued, Active, Deferred, Total
- Last monitored timestamp
- Status indicator (Active, Idle, High Backlog)

### Queue Detail (`/queues/:name`)

Detailed view of a single queue:

- **Stats**: Queued, Active, Deferred, Total counts
- **Jobs Table**: Paginated list of jobs with:
  - Job ID (truncated UUID)
  - State (created, retry, active, completed, cancelled, failed)
  - Priority
  - Retry count / limit
  - Created timestamp
  - Actions (Cancel, Retry, Delete)

**Filtering**: Use the state dropdown to filter jobs by state.

**Job Actions**:
- **Cancel**: Cancels jobs in `created`, `retry`, or `active` state
- **Retry**: Re-queues `failed` jobs for another attempt
- **Delete**: Removes jobs (not available for `active` jobs)

### Warnings (`/warnings`)

History of pg-boss warnings with:

- Warning type (Slow Query, Queue Backlog, Clock Skew)
- Message
- Additional details (elapsed time, queue name, etc.)
- Timestamp

**Filtering**: Use the type dropdown to filter by warning type.

> **Note**: Warnings are only recorded when pg-boss is configured with `persistWarnings: true`.

## Enabling Warning Persistence

To capture warnings in the dashboard, enable warning persistence in your pg-boss configuration:

```javascript
const PgBoss = require('pg-boss');

const boss = new PgBoss({
  connectionString: 'postgres://localhost/mydb',
  persistWarnings: true  // Enable warning persistence
});
```

This creates a `warning` table in your pg-boss schema that stores:
- `slow_query`: Queries taking longer than expected
- `queue_backlog`: Queues exceeding their warning threshold
- `clock_skew`: Database clock drift detection

## Tech Stack

- **Framework**: [React Router 7](https://reactrouter.com/) (framework mode)
- **Server**: [Hono](https://hono.dev/) via [react-router-hono-server](https://github.com/rphlmr/react-router-hono-server)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Components**: [React Aria Components](https://react-spectrum.adobe.com/react-aria/components.html)
- **Database**: [pg](https://node-postgres.com/) (PostgreSQL client)
- **Testing**: [Vitest](https://vitest.dev/) + [Testing Library](https://testing-library.com/)

## Development (Contributing)

To work on the dashboard from source:

```bash
# Clone the pg-boss repository
git clone https://github.com/timgit/pg-boss.git
cd pg-boss/packages/dashboard

# Install dependencies
npm install

# Initialize local database with pg-boss schema and test queues
npm run dev:init-db

# Start development server with hot reloading
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

The `dev:init-db` script creates the pg-boss schema and populates it with sample queues and jobs for testing. It connects to `postgres://postgres:postgres@127.0.0.1:5432/pgboss` by default.

### Project Structure

```
packages/dashboard/
├── app/
│   ├── components/
│   │   ├── layout/         # Sidebar, page layout
│   │   └── ui/             # Reusable UI components
│   ├── lib/
│   │   ├── db.server.ts    # Database connection pool
│   │   ├── queries.server.ts # SQL queries
│   │   ├── types.ts        # TypeScript types
│   │   └── utils.ts        # Shared utilities
│   ├── routes/
│   │   ├── _index.tsx      # Dashboard overview
│   │   ├── queues._index.tsx # Queues list
│   │   ├── queues.$name.tsx  # Queue detail
│   │   └── warnings.tsx    # Warnings history
│   ├── root.tsx            # Root layout
│   ├── routes.ts           # Route configuration
│   └── server.ts           # Hono server setup
├── tests/
│   ├── frontend/           # React component tests
│   ├── server/             # Server-side tests (queries, utils)
│   └── setup.ts            # Test setup (jsdom, mocks)
├── package.json
├── vite.config.ts
├── vitest.config.frontend.ts # Frontend test config
└── vitest.config.server.ts   # Server test config
```

### Running Tests

```bash
# All tests (frontend + server)
npm test

# Frontend tests only (React components)
npm run test:frontend

# Server tests only (queries, utils - requires PostgreSQL)
npm run test:server

# All tests with coverage
npm run cover

# Individual coverage reports
npm run cover:frontend
npm run cover:server
```

### Type Checking

```bash
npm run typecheck
```

## API Reference

The dashboard reads directly from pg-boss database tables:

- `{schema}.queue` - Queue metadata and cached job counts
- `{schema}.job` - Individual jobs
- `{schema}.warning` - Warning history (when `persistWarnings` is enabled)

### Queue Table Fields Used

| Field | Description |
|-------|-------------|
| `name` | Queue name |
| `policy` | Queue policy (standard, short, singleton, stately) |
| `queued_count` | Number of jobs waiting to be processed |
| `active_count` | Number of jobs currently being processed |
| `deferred_count` | Number of jobs scheduled for later |
| `total_count` | Total job count |
| `warning_queued` | Threshold for backlog warnings |
| `monitor_on` | Last monitoring timestamp |

### Job States

| State | Description |
|-------|-------------|
| `created` | Job is queued and waiting |
| `retry` | Job failed and is scheduled for retry |
| `active` | Job is currently being processed |
| `completed` | Job finished successfully |
| `cancelled` | Job was cancelled |
| `failed` | Job failed after exhausting retries |

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

## License

MIT
