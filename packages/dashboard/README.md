# pg-boss Dashboard

A web-based dashboard for monitoring and managing [pg-boss](https://github.com/timgit/pg-boss) job queues — browse queues, inspect and act on jobs, and review warning history from a single UI.

📖 **[Read the full documentation →](https://pgboss.dev/dashboard)**

## Quick Start

```bash
npm install @pg-boss/dashboard
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-dashboard
```

Open http://localhost:3000 in your browser.

Requires Node.js 22.12+ and a PostgreSQL database with a pg-boss schema (pg-boss 12.24+ recommended). For configuration, multi-database setup, production deployment, warning persistence, and troubleshooting, see the [documentation](https://pgboss.dev/dashboard).

## Development

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

## License

MIT
