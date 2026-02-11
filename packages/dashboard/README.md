# pg-boss Dashboard

A web-based dashboard for monitoring and managing [pg-boss](https://github.com/timgit/pg-boss) job queues.

## Features

- **Overview**: Aggregate statistics, problem queues, and recent warnings at a glance
- **Queue Management**: View all queues with cached statistics and create new queues
- **Job List**: View jobs with state and queue filtering
- **Job Details**: View full job payloads, output data, and metadata
- **Job Actions**: Create, cancel, retry, resume, or delete jobs directly from the UI
- **Warning History**: When `persistWarnings` is enabled, browse through previously emitted warning events. 
- **Multi-Schema Support**: Monitor multiple pg-boss instances from a single dashboard
- **Mobile Responsive**: Full functionality on mobile devices with collapsible sidebar
- **Shareable URLs**: Database selection and filters are preserved in URLs for easy sharing

## Requirements

- Node.js 22.12+
- PostgreSQL database with pg-boss schema
- pg-boss 12.11+

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

## Enabling Warning Persistence

To capture warnings in the dashboard, enable warning persistence in your pg-boss configuration:

```javascript
const PgBoss = require('pg-boss');

const boss = new PgBoss({
  connectionString: 'postgres://localhost/mydb',
  persistWarnings: true  // Enable warning persistence
});
```

Warnings correlate to `warning` events already emitted by pg-boss:
- `slow_query`: Queries taking longer than expected
- `queue_backlog`: Queues exceeding their warning threshold
- `clock_skew`: Database clock drift detection

## Tech Stack

- **Framework**: [React Router 7](https://reactrouter.com/) (framework mode)
- **Server**: [Hono](https://hono.dev/) via [react-router-hono-server](https://github.com/rphlmr/react-router-hono-server)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Components**: [Base UI](https://base-ui.com/)
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

# (Optional) Start a worker to process jobs
# Run this in a separate terminal to see jobs being processed
npm run dev:worker

# Build for production
npm run build

# Run production build
npm start
```

The `dev:init-db` script creates the pg-boss schema and populates it with sample queues and jobs for testing. It connects to `postgres://postgres:postgres@127.0.0.1:5432/pgboss` by default.

The `dev:worker` script starts a worker that processes jobs from the same pg-boss instance as the dashboard. This is useful for testing the dashboard while jobs are being processed. The worker will stay running until you stop it with Ctrl+C.

### Testing

```bash
# All tests (frontend + server)
npm test

# Full CI test (used by GitHub Actions)
npm run ci
```

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
