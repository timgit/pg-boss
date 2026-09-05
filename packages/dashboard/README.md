# pg-boss Dashboard

A web-based dashboard for monitoring and managing [pg-boss](https://github.com/timgit/pg-boss) job queues — browse queues, inspect and act on jobs, and review warning history from a single UI.

📖 **[Read the full documentation →](https://pgboss.io/dashboard)**

## Quick Start

```bash
npm install @pg-boss/dashboard
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-dashboard
```

Open http://localhost:3000 in your browser.


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

### Testing

```bash
# All tests (frontend + server)
npm test

# Full CI test (used by GitHub Actions)
npm run ci
```

## License

MIT
