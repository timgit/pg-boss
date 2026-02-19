# @pg-boss/proxy

A HTTP proxy for pg-boss methods, to support use cases such as platform compatibility and connection pooling or scalability.

All background processing is disabled by default (the opposite of how pg-boss normally works). A pg-boss instance is started via `start()`, which opens the database connection.

## Quick Start

**As a library** (import into your own Node app):

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'

const proxy = createProxyServerNode()
await proxy.start()
// Reads DATABASE_URL from process.env, listens on PORT (default 3000)
```

**From source** (clone the repo and run the built-in dev server):

```bash
npm run dev
```

Then visit:
- http://localhost:3000 - Proxy home page with links to all endpoints
- http://localhost:3000/docs - Interactive Swagger documentation
- http://localhost:3000/openapi.json - OpenAPI spec


## API Usage Examples

Once the proxy is running, you can interact with it using any HTTP client:

```bash
# Send a job to a queue
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d '{"name": "my-queue", "data": {"key": "value"}}'

# Fetch jobs from a queue
curl -X POST http://localhost:3000/api/fetch \
  -H "Content-Type: application/json" \
  -d '{"name": "my-queue"}'

# Get queue information
curl "http://localhost:3000/api/getQueue?name=my-queue"

# Get all queues
curl "http://localhost:3000/api/getQueues"
```

## Response Format

All endpoints return a consistent JSON envelope:

```json
// Success
{ "ok": true, "result": <value | null> }

// Error
{ "ok": false, "error": { "message": "..." } }
```

The `result` field contains the direct return value of the underlying pg-boss method. HTTP status codes used: `200` for success, `400` for invalid input, `413` for body too large, and `500` for server errors.

## Entry Points

This package ships a runtime-neutral entry point and a Node-only entry point.

### Runtime-neutral (default)

Use this when you want a runtime-neutral entry point:

```ts
import { createProxyService } from '@pg-boss/proxy'

const { app, start, stop } = createProxyService({
  options: {
    connectionString: 'postgres://user:pass@host/database'
  }
})

await start()
// later
await stop()
```

If you only need the Hono app and will manage lifecycle yourself:

```ts
import { createProxyApp } from '@pg-boss/proxy'
import { serve } from '@hono/node-server'

const { app, boss } = createProxyApp({
  options: {
    connectionString: 'postgres://user:pass@host/database'
  }
})

await boss.start()
// Use with any Hono-compatible server
serve({ fetch: app.fetch, port: 3000 })
```

### Node Convenience Entry Point

If you want a ready-to-listen Node server with automatic shutdown signal wiring:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'

const proxy = createProxyServerNode()
await proxy.start()
```

## Lifecycle Wiring by Runtime

`createProxyServerNode` automatically attaches `SIGINT` and `SIGTERM` handlers. Set `attachSignals: false` to opt out and manage shutdown yourself.

For `createProxyService` and `createProxyApp` (runtime-neutral), or for non-Node runtimes, wire shutdown manually using `attachShutdownListeners` and the appropriate adapter:

### Node

```ts
import { attachShutdownListeners, createProxyService, nodeShutdownAdapter } from '@pg-boss/proxy'

const { app, start, stop } = createProxyService({
  options: { connectionString: process.env.DATABASE_URL }
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], nodeShutdownAdapter, stop)
```

### Deno

```ts
import { attachShutdownListeners, createDenoShutdownAdapter, createProxyService } from '@pg-boss/proxy'

const { start, stop } = createProxyService({
  options: {
    connectionString: Deno.env.get('DATABASE_URL')
  }
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], createDenoShutdownAdapter(), stop)
```

### Bun

```ts
import { attachShutdownListeners, createProxyService, bunShutdownAdapter } from '@pg-boss/proxy'

const { start, stop } = createProxyService({
  options: { connectionString: process.env.DATABASE_URL }
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], bunShutdownAdapter, stop)
```

## Configuration

You can configure the proxy using either **code options** or **environment variables**. Code options take precedence over environment variables if both are set.

### Code Options

The proxy accepts the following options:

```ts
import { createProxyApp } from '@pg-boss/proxy'

const { app, boss } = createProxyApp({
  options: { connectionString: process.env.DATABASE_URL },
  prefix: '/api',
  requestLogger: true,
  logFormat: 'text', // 'text' or 'json'
  exposeErrors: false,
  bodyLimit: 1024 * 1024,
  routes: {
    allow: ['send', 'fetch'],
    deny: ['deleteQueue']
  },
  pages: {
    root: true,
    docs: true,
    openapi: true
  },
  auth: {
    username: 'admin',
    password: 'secret'
  },
  cors: {
    origin: 'https://example.com',
    methods: 'GET,POST',
    credentials: true
  }
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `options` | `ConstructorOptions` | - | PgBoss constructor options |
| `prefix` | `string` | `/api` | URL prefix for all API routes |
| `env` | `Record<string, string>` | `process.env` | Environment variables |
| `middleware` | `MiddlewareHandler \| MiddlewareHandler[]` | - | Hono middleware to apply to API routes |
| `requestLogger` | `boolean` | `true` | Enable/disable default request logging middleware |
| `logFormat` | `'text' \| 'json'` | `text` | Log output format |
| `exposeErrors` | `boolean` | `false` | Return actual error messages to clients |
| `bodyLimit` | `number` | `1048576` (1MB) | Max request body size in bytes |
| `routes.allow` | `string[]` | all | List of pg-boss methods to expose |
| `routes.deny` | `string[]` | none | List of pg-boss methods to exclude |
| `pages.root` | `boolean` | `true` | Enable/disable the root page (`/`) |
| `pages.docs` | `boolean` | `true` | Enable/disable Swagger docs (`/docs`) |
| `pages.openapi` | `boolean` | `true` | Enable/disable OpenAPI spec (`/openapi.json`) |
| `auth.username` | `string` | - | Basic auth username |
| `auth.password` | `string` | - | Basic auth password |
| `cors.origin` | `string` | - | CORS allowed origins |
| `cors.methods` | `string` | `GET,POST,PUT,DELETE,PATCH,OPTIONS` | CORS allowed methods |
| `cors.headers` | `string` | `Content-Type,Authorization` | CORS allowed headers |

### Environment Variables

Alternatively, configure everything via environment variables:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | - | PostgreSQL connection string |
| `PORT` | `3000` | Listening port |
| `HOST` | `localhost` | Listening hostname |
| `PGBOSS_PROXY_PREFIX` | `/api` | URL prefix for API routes |
| `PGBOSS_PROXY_REQUEST_LOGGER` | `true` | Enable request logging |
| `PGBOSS_PROXY_LOG_FORMAT` | `text` | Log format: `text` or `json` |
| `PGBOSS_PROXY_EXPOSE_ERRORS` | `false` | Return actual error messages to clients |
| `PGBOSS_PROXY_BODY_LIMIT` | `1048576` | Max request body size in bytes |
| `PGBOSS_PROXY_ROUTES_ALLOW` | all | Comma-separated list of routes to expose |
| `PGBOSS_PROXY_ROUTES_DENY` | none | Comma-separated list of routes to exclude |
| `PGBOSS_PROXY_PAGE_ROOT` | `true` | Enable root page |
| `PGBOSS_PROXY_PAGE_DOCS` | `true` | Enable Swagger docs |
| `PGBOSS_PROXY_PAGE_OPENAPI` | `true` | Enable OpenAPI spec |
| **Authentication** | | |
| `PGBOSS_PROXY_AUTH_USERNAME` | - | Basic auth username (must be set with password) |
| `PGBOSS_PROXY_AUTH_PASSWORD` | - | Basic auth password (must be set with username) |
| **CORS** | | |
| `PGBOSS_PROXY_CORS_ORIGIN` | - | CORS allowed origins (comma-separated or `*`) |
| `PGBOSS_PROXY_CORS_METHODS` | `GET,POST,PUT,DELETE,PATCH,OPTIONS` | CORS allowed methods |
| `PGBOSS_PROXY_CORS_HEADERS` | `Content-Type,Authorization` | CORS allowed headers |
| `PGBOSS_PROXY_CORS_EXPOSE_HEADERS` | - | CORS exposed headers |
| `PGBOSS_PROXY_CORS_CREDENTIALS` | `false` | CORS allow credentials |
| `PGBOSS_PROXY_CORS_MAX_AGE` | - | CORS preflight cache duration (seconds) |

### PgBoss Constructor Options

You can pass any PgBoss constructor options via the `options` object:

```ts
const { app, boss } = createProxyApp({
  options: {
    connectionString: 'postgres://user:pass@host/database',
    schema: 'custom',
    supervise: true,    // enable job supervision (disabled by default)
    schedule: true,     // enable job creation by monitoring cron schedules (disabled by default)
    migrate: true       // run migrations on startup if needed (disabled by default)
  }
})
```

By default, `supervise`, `schedule`, and `migrate` are set to `false` to run the proxy in a stateless manner. Set any of these to `true` to enable that functionality.

### Authentication

Basic auth can be enabled via environment variables:

```bash
PGBOSS_PROXY_AUTH_USERNAME=admin
PGBOSS_PROXY_AUTH_PASSWORD=secret
```

Both variables must be set together. When enabled, auth is applied to all routes under the prefix (e.g., `/api/*`). The root page (`/`), Swagger docs (`/docs`), and OpenAPI spec (`/openapi.json`) sit outside the prefix and remain publicly accessible.

### CORS

CORS can be enabled via environment variables:

```bash
# Required: comma-separated list of allowed origins (use "*" for any)
PGBOSS_PROXY_CORS_ORIGIN=https://example.com,https://app.example.com

# Optional: allowed HTTP methods (default: GET, POST, PUT, DELETE, PATCH, OPTIONS)
PGBOSS_PROXY_CORS_METHODS=GET,POST,PUT,DELETE

# Optional: allowed request headers (default: Content-Type, Authorization)
PGBOSS_PROXY_CORS_HEADERS=Content-Type,Authorization,X-Custom-Header

# Optional: headers exposed to the client (default: none)
PGBOSS_PROXY_CORS_EXPOSE_HEADERS=X-Request-Id

# Optional: allow credentials (default: false)
PGBOSS_PROXY_CORS_CREDENTIALS=true

# Optional: preflight cache duration in seconds (default: none)
PGBOSS_PROXY_CORS_MAX_AGE=3600
```

When `PGBOSS_PROXY_CORS_ORIGIN` is set, CORS middleware is applied to all routes under the prefix. The root page and docs remain unaffected.

### Request Logging

The proxy uses [LogTape](https://logtape.org/) for request and application logging.

`packages/proxy/src/server.ts` shows a complete example using a console sink:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'
import { configure, getConsoleSink, getLogger } from '@logtape/logtape'

await configure({
  sinks: { console: getConsoleSink() },
  loggers: [
    { category: ['pg-boss', 'proxy'], lowestLevel: 'info', sinks: ['console'] },
    { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: ['console'] }
  ]
})

const logger = getLogger(['pg-boss', 'proxy'])
const proxy = createProxyServerNode()

const info = await proxy.start()
logger.info(`pg-boss proxy listening on http://${proxy.hostname}:${info.port}`)
```

#### JSON Logging

For structured logging (e.g., when using log aggregation tools), use the JSON Lines formatter:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'
import { configure, getConsoleSink, getLogger, jsonLinesFormatter } from '@logtape/logtape'

await configure({
  sinks: {
    console: getConsoleSink({ formatter: jsonLinesFormatter() })
  },
  loggers: [
    { category: ['pg-boss', 'proxy'], lowestLevel: 'info', sinks: ['console'] },
    { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: ['console'] }
  ]
})

const logger = getLogger(['pg-boss', 'proxy'])
const proxy = createProxyServerNode()

await proxy.start()
logger.info('server started', { port: 3000 })
```

Output:
```json
{"timestamp":"2025-01-15T10:30:00.000Z","level":"info","message":"server started","properties":{"port":3000},"context":{}}
```

You can also log to a file with JSON Lines format:

```ts
import { getFileSink } from '@logtape/file'

await configure({
  sinks: {
    file: getFileSink('logs/proxy.jsonl', { formatter: jsonLinesFormatter() })
  },
  loggers: [
    { category: ['pg-boss', 'proxy'], lowestLevel: 'info', sinks: ['file'] }
  ]
})
```

### Custom Middleware

You can add custom Hono middleware to the API routes:

```ts
import { secureHeaders } from 'hono/secure-headers'

const { app, boss } = createProxyApp({
  options: { connectionString: 'postgres://user:pass@host/database' },
  middleware: [
    secureHeaders({
      xFrameOptions: false,
      xXssProtection: false
    })
  ]
})
```

### Custom PgBoss Factory

For advanced customization, you can provide a custom `bossFactory` function to wrap or modify pg-boss behavior:

```ts
import { PgBoss } from 'pg-boss'

const { app, boss } = createProxyApp({
  bossFactory: (options) => {
    const instance = new PgBoss({
      ...options,
      // Custom configuration
    })

    // Wrap methods with logging
    const originalSend = instance.send.bind(instance)
    instance.send = async (...args) => {
      console.log('send called with:', args)
      return originalSend(...args)
    }

    return instance
  }
})

await boss.start()
```

### Route Filtering

You can allowlist or denylist pg-boss methods to control which API routes are exposed:

```ts
const { app, boss } = createProxyApp({
  options: { connectionString: 'postgres://user:pass@host/database' },
  routes: {
    // Only expose safe operations (default: all methods are exposed)
    allow: ['send', 'fetch', 'complete', 'fail', 'getQueue', 'getQueues']
  }
})
```

Or deny specific methods:

```ts
const { app, boss } = createProxyApp({
  options: { connectionString: 'postgres://user:pass@host/database' },
  routes: {
    // Exclude destructive operations
    deny: ['deleteQueue', 'deleteAllJobs', 'deleteStoredJobs']
  }
})
```

### Disabling Pages

You can disable the root page, docs, or OpenAPI spec:

```ts
const { app, boss } = createProxyApp({
  options: { connectionString: 'postgres://user:pass@host/database' },
  pages: {
    root: false,      // Disable the home page
    docs: false,      // Disable Swagger UI
    openapi: false    // Disable OpenAPI JSON endpoint
  }
})
```

## Running from Source

```bash
# Start dev server
DATABASE_URL=postgres://user:pass@host/database npm run dev

# With custom port
PORT=8080 DATABASE_URL=postgres://user:pass@host/database npm run dev

# With authentication
DATABASE_URL=postgres://user:pass@host/database \
PGBOSS_PROXY_AUTH_USERNAME=admin \
PGBOSS_PROXY_AUTH_PASSWORD=secret \
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

### Docker

```dockerfile
FROM node:24
WORKDIR /app
RUN npm install -g @pg-boss/proxy
ENV PORT=3000
EXPOSE 3000
CMD ["pg-boss-proxy"]
```

```bash
docker build -t pgboss-proxy .
docker run -d \
  -e DATABASE_URL="postgres://user:pass@host:5432/db" \
  -e PGBOSS_PROXY_AUTH_USERNAME=admin \
  -e PGBOSS_PROXY_AUTH_PASSWORD=secret \
  -e PGBOSS_PROXY_CORS_ORIGIN="https://myapp.com" \
  -p 3000:3000 \
  pgboss-proxy
```

### Docker Compose

```yaml
services:
  proxy:
    image: node:24
    working_dir: /app
    command: sh -c "npm install -g @pg-boss/proxy && pgboss-proxy"
    environment:
      DATABASE_URL: postgres://user:pass@db:5432/mydb
      PGBOSS_SCHEMA: pgboss
      PORT: 3000
      PGBOSS_PROXY_REQUEST_LOGGER: "true"
      PGBOSS_PROXY_LOG_FORMAT: "json"
      PGBOSS_PROXY_AUTH_USERNAME: admin
      PGBOSS_PROXY_AUTH_PASSWORD: secret
      PGBOSS_PROXY_CORS_ORIGIN: "https://myapp.com"
    ports:
      - "3000:3000"
    depends_on:
      - db

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: mydb
    ports:
      - "5432:5432"
```

## API Reference

- [Interactive API Docs](http://localhost:3000/docs) - Swagger UI for exploring all endpoints
- [OpenAPI Spec](http://localhost:3000/openapi.json) - Machine-readable API specification
- [pg-boss Docs](https://timgit.github.io/pg-boss) - pg-boss documentation
