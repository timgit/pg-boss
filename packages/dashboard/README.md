# pg-boss Dashboard

A web dashboard for [pg-boss](https://github.com/timgit/pg-boss) job queues. It shows queues, jobs, schedules, subscriptions, instances and warning history. It also manages jobs, schedules and subscriptions.

📖 **[Read the full documentation →](https://pgboss.io/dashboard)**

[pg-boss Pro](https://pgboss.io/pro/) is built on the dashboard and supported by the author of pg-boss. Available as a subscription, it adds user accounts with roles, an audit log, customizable alert rules and the Pro API for automation scripts. Pro helps fund the ongoing development and maintenance of pg-boss as well as the dashboard.

## Quick Start

```bash
npm install @pg-boss/dashboard
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx @pg-boss/dashboard
```

Open http://localhost:3000 in your browser.

Already running a Node.js server? The dashboard can be [mounted inside it](https://pgboss.io/dashboard#mounting-inside-an-existing-application) instead of running as a separate process.


## Development

To work on the dashboard from source:

```bash
# Clone the pg-boss repository
git clone https://github.com/timgit/pg-boss.git
cd pg-boss/packages/dashboard

# Install dependencies
npm install

# Initialize local database with pg-boss schema and demo data
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

The dashboard runs against the published `pg-boss` in its `dependencies`. To work on a change that needs core from this repository that is not on npm yet, set `PGBOSS_CORE=src` for dev and tests. The build refuses it, so a release always runs against the published package.

```bash
PGBOSS_CORE=src npm run dev
PGBOSS_CORE=src npm test
TSX_TSCONFIG_PATH=tsconfig.core-src.json npm run dev:init-db
npx tsc --noEmit -p tsconfig.core-src.json
```

### Testing

```bash
# All tests (frontend + server)
npm test

# Full CI test (used by GitHub Actions)
npm run ci
```

## License

MIT
