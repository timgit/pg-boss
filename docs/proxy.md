# Proxy

An HTTP proxy is available in the [`@pg-boss/proxy`](https://www.npmjs.com/package/@pg-boss/proxy) package, exposing pg-boss methods over a simple JSON API. It's useful for platform compatibility (calling pg-boss from non-Node runtimes or serverless functions) and for connection pooling and scalability.

By default the proxy runs statelessly — job supervision, scheduling, and migrations are all disabled, so it only opens a database connection and serves requests. A pg-boss instance is started via `start()`, which opens the database connection.

## Features

- **HTTP API**: Call pg-boss methods (`send`, `fetch`, `complete`, `getQueue`, and more) over plain JSON
- **Runtime Neutral**: Ships a runtime-neutral entry point plus a Node convenience server, with shutdown adapters for Node, Deno, and Bun
- **Interactive Docs**: Built-in Swagger UI and an OpenAPI spec served alongside the API
- **Route Filtering**: Allowlist or denylist specific pg-boss methods to control what's exposed
- **Auth & CORS**: Optional basic authentication and configurable CORS
- **Configurable**: Drive everything from code options or environment variables

## Quick Start

```bash
npm install @pg-boss/proxy
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-proxy
```

Then visit:

- `http://localhost:3000` — proxy home page with links to all endpoints
- `http://localhost:3000/docs` — interactive Swagger documentation
- `http://localhost:3000/openapi.json` — OpenAPI spec

Or embed it in your own Node app:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'

const proxy = await createProxyServerNode()
await proxy.start()
// Reads DATABASE_URL from process.env, listens on PORT (default 3000)
```

## API Usage

Once the proxy is running, interact with it using any HTTP client:

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

const { app, start, stop } = await createProxyService({
  options: {
    connectionString: 'postgres://user:pass@host/database'
  }
})

await start()
// later
await stop()
```

### Node Convenience Entry Point

If you want a ready-to-listen Node server with automatic shutdown signal wiring:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'

const proxy = await createProxyServerNode()
await proxy.start()
```

## Lifecycle Wiring by Runtime

`createProxyServerNode` automatically attaches `SIGINT` and `SIGTERM` handlers. Set `attachSignals: false` to opt out and manage shutdown yourself.

For `createProxyService` (runtime-neutral), or for non-Node runtimes, wire shutdown manually using `attachShutdownListeners` and the appropriate adapter:

### Node

```ts
import { attachShutdownListeners, createProxyService, nodeShutdownAdapter } from '@pg-boss/proxy'

const { app, start, stop } = await createProxyService({
  options: { connectionString: process.env.DATABASE_URL }
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], nodeShutdownAdapter, stop)
```

### Deno

```ts
import { attachShutdownListeners, createDenoShutdownAdapter, createProxyService } from '@pg-boss/proxy'

const { start, stop } = await createProxyService({
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

const { start, stop } = await createProxyService({
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
import { createProxyService } from '@pg-boss/proxy'

const { app, boss } = await createProxyService({
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
| `port` | `number` | `3000` | Listening port |
| `hostname` | `string` | `localhost` | Listening hostname |
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
const { app, boss } = await createProxyService({
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

### Custom Middleware

You can add custom Hono middleware to the API routes:

```ts
import { secureHeaders } from 'hono/secure-headers'

const { app, boss } = await createProxyService({
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

const { app, boss } = await createProxyService({
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
const { app, boss } = await createProxyService({
  options: { connectionString: 'postgres://user:pass@host/database' },
  routes: {
    // Only expose safe operations (default: all methods are exposed)
    allow: ['send', 'fetch', 'complete', 'fail', 'getQueue', 'getQueues']
  }
})
```

Or deny specific methods:

```ts
const { app, boss } = await createProxyService({
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
const { app, boss } = await createProxyService({
  options: { connectionString: 'postgres://user:pass@host/database' },
  pages: {
    root: false,      // Disable the home page
    docs: false,      // Disable Swagger UI
    openapi: false    // Disable OpenAPI JSON endpoint
  }
})
```

## Deployment

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
    command: sh -c "npm install -g @pg-boss/proxy && pg-boss-proxy"
    environment:
      DATABASE_URL: postgres://user:pass@db:5432/mydb
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

- `http://localhost:3000/docs` — Swagger UI for exploring all endpoints
- `http://localhost:3000/openapi.json` — machine-readable OpenAPI specification

## Contributing

To work on the proxy from source, see the [package README](https://github.com/timgit/pg-boss/blob/master/packages/proxy/README.md#running-from-source).
