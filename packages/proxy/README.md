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
DATABASE_URL=postgres://user:pass@host/database npm run dev
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

```ts
import { createProxyServiceNode } from '@pg-boss/proxy/node'

const { app, start, stop } = createProxyServiceNode()

await start()
// later
await stop()
```

If you want a ready-to-listen Node server with automatic shutdown signal wiring:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'

const proxy = createProxyServerNode()
await proxy.start()
```

`createProxyServerNode` accepts all `ProxyOptions` plus the following Node-specific options:

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | `PORT` env or `3000` | Port to listen on |
| `hostname` | `string` | `HOST` env or `localhost` | Hostname to bind |
| `shutdownSignals` | `NodeJS.Signals[]` | `['SIGINT', 'SIGTERM']` | Signals that trigger graceful shutdown |
| `attachSignals` | `boolean` | `true` | Auto-attach shutdown signal handlers |
| `onListen` | `(info: { port: number }) => void` | - | Called after the server starts listening |

You can override environment lookups by passing an `env` object:

```ts
const proxy = createProxyServerNode({
  env: {
    DATABASE_URL: 'postgres://user:pass@host/database',
    HOST: '0.0.0.0',
    PORT: '8080'
  }
})
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

The proxy accepts the following options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `options` | `ConstructorOptions` | - | PgBoss constructor options (see below) |
| `prefix` | `string` | `/api` | URL prefix for all API routes |
| `env` | `Record<string, string>` | `process.env` | Environment variables |
| `middleware` | `MiddlewareHandler \| MiddlewareHandler[]` | - | Hono middleware to apply to API routes |
| `exposeErrors` | `boolean` | `false` | Return actual error messages to clients |
| `bodyLimit` | `number` | `1048576` (1MB) | Max request body size in bytes |
| `routes.allow` | `string[]` | all | List of pg-boss methods to expose |
| `routes.deny` | `string[]` | none | List of pg-boss methods to exclude |
| `pages.root` | `boolean` | `true` | Enable/disable the root page (`/`) |
| `pages.docs` | `boolean` | `true` | Enable/disable Swagger docs (`/docs`) |
| `pages.openapi` | `boolean` | `true` | Enable/disable OpenAPI spec (`/openapi.json`) |

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | - | PostgreSQL connection string |
| `PORT` | `3000` | Listening port (Node entry point only) |
| `HOST` | `localhost` | Listening hostname (Node entry point only) |
| `PGBOSS_PROXY_AUTH_USERNAME` | - | Basic auth username (must be set with password) |
| `PGBOSS_PROXY_AUTH_PASSWORD` | - | Basic auth password (must be set with username) |

### PgBoss Constructor Options

You can pass any PgBoss constructor options via the `options` object:

```ts
const { app, boss } = createProxyApp({
  options: {
    connectionString: 'postgres://user:pass@host/database',
    schema: 'custom',
    supervise: true,    // enable job supervision (disabled by default)
    schedule: true,     // enable job scheduling (disabled by default)
    migrate: true       // run migrations on startup (disabled by default)
  }
})
```

By default, `supervise`, `schedule`, and `migrate` are set to `false` to run the proxy in a stateless manner. Set any of these to `true` to enable that functionality.

### Request Logging

All requests are logged to stdout via the built-in `hono/logger` middleware.

### Authentication

Basic auth can be enabled via environment variables:

```bash
PGBOSS_PROXY_AUTH_USERNAME=admin
PGBOSS_PROXY_AUTH_PASSWORD=secret
```

Both variables must be set together. When enabled, auth is applied to all routes under the prefix (e.g., `/api/*`). The root page (`/`), Swagger docs (`/docs`), and OpenAPI spec (`/openapi.json`) sit outside the prefix and remain publicly accessible.

### Custom Middleware

You can add custom Hono middleware to the API routes:

```ts
import { cors } from 'hono/cors'

const { app, boss } = createProxyApp({
  options: { connectionString: 'postgres://user:pass@host/database' },
  middleware: [
    // Add CORS headers
    cors({
      origin: ['https://myapp.com'],
      credentials: true
    }),
    // Add any other Hono-compatible middleware here
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

## Complete Production Example

Here's a production-ready setup with authentication, CORS, and restricted routes:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'
import { cors } from 'hono/cors'

const proxy = createProxyServerNode({
  options: {
    connectionString: process.env.DATABASE_URL,
    schema: 'pgboss'
  },
  prefix: '/api',
  middleware: [
    cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [] })
  ],
  routes: {
    // Only expose safe operations
    allow: [
      'send',
      'sendAfter',
      'sendDebounced',
      'sendThrottled',
      'fetch',
      'complete',
      'fail',
      'cancel',
      'retry',
      'getQueue',
      'getQueues',
      'getSchedules',
      'findJobs'
    ]
  },
  bodyLimit: 1024 * 1024, // 1MB
  exposeErrors: false
})

// Server will use HOST and PORT from env (defaults: localhost:3000)
await proxy.start()

console.log(`pg-boss proxy running at http://${proxy.hostname}:${proxy.port}`)
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

## API Reference

- [Interactive API Docs](http://localhost:3000/docs) - Swagger UI for exploring all endpoints
- [OpenAPI Spec](http://localhost:3000/openapi.json) - Machine-readable API specification
- [pg-boss Docs](https://timgit.github.io/pg-boss) - pg-boss documentation
