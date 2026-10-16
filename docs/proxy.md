# Proxy

The [`@pg-boss/proxy`](https://www.npmjs.com/package/@pg-boss/proxy) package is an HTTP proxy that exposes pg-boss methods over a JSON API. Use it to call pg-boss from non-Node runtimes or serverless functions, or to pool connections as you scale.

By default the proxy is stateless. It turns off job supervision, scheduling and migrations, so it only opens a database connection and serves requests. `start()` starts its pg-boss instance, which opens the database connection.

## Features

- Call pg-boss methods (`send`, `fetch`, `complete`, `getQueue`, and more) over plain JSON.
- Run it on any runtime. It ships a runtime-neutral entry point and a Node server, with shutdown adapters for Node, Deno and Bun.
- Explore the API in the built-in Swagger UI, with an OpenAPI spec served next to it.
- Allowlist or denylist specific pg-boss methods to control what's exposed.
- Turn on basic authentication and CORS, both optional.
- Configure everything from code options or environment variables.

## Quick start

```bash
npm install @pg-boss/proxy
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-proxy
```

Then visit:

- `http://localhost:3000`: proxy home page with links to all endpoints
- `http://localhost:3000/docs`: interactive Swagger documentation
- `http://localhost:3000/openapi.json`: OpenAPI spec

Or embed it in your own Node app:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'

const proxy = await createProxyServerNode()
await proxy.start()
// Reads DATABASE_URL from process.env, listens on PORT (default 3000)
```

## API usage

Once the proxy is running, call it from any HTTP client:

```bash
# Send a job to a queue
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d '{"name": "my-queue", "data": {"key": "value"}}'

# Fetch jobs from a queue
curl -X POST http://localhost:3000/api/fetch \
  -H "Content-Type: application/json" \
  -d '{"name": "my-queue"}'

# Complete a fetched job. Passing the job (or its id and retryCount) instead of the id
# settles only the attempt you fetched. See /api/jobs#passing-jobs-instead-of-ids
curl -X POST http://localhost:3000/api/complete \
  -H "Content-Type: application/json" \
  -d '{"name": "my-queue", "id": {"id": "<job id>", "retryCount": 0}}'

# Get queue information
curl "http://localhost:3000/api/getQueue?name=my-queue"

# Get all queues
curl "http://localhost:3000/api/getQueues"
```

## Response format

Every endpoint returns the same JSON envelope:

```json
// Success
{ "ok": true, "result": <value | null> }

// Error
{ "ok": false, "error": { "message": "..." } }
```

The `result` field holds the return value of the pg-boss method. The proxy answers `200` for success, `400` for invalid input, `413` for a body that's too large, and `500` for a server error.

## Entry points

This package ships a runtime-neutral entry point and a Node-only entry point.

### Runtime-neutral (default)

This entry point runs on any runtime:

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

### Node convenience entry point

This entry point gives you a Node server that's ready to listen and handles shutdown signals for you:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'

const proxy = await createProxyServerNode()
await proxy.start()
```

## Lifecycle wiring by runtime

`createProxyServerNode` automatically attaches `SIGINT` and `SIGTERM` handlers. Set `attachSignals: false` to opt out and manage shutdown yourself.

With `createProxyService`, or on a runtime other than Node, wire up shutdown yourself with `attachShutdownListeners` and the adapter for your runtime:

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

Configure the proxy with **code options** or **environment variables**. When both set the same thing, the code option wins.

### Code options

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
| `authorize` | `(context, method) => AuthorizeResult` | - | Decides each API request with the pg-boss method it calls. See [Authorizing Each Call](#authorizing-each-call) |
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

### Environment variables

Or configure everything with environment variables:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | - | PostgreSQL connection string |
| `PORT` | `3000` | Listening port |
| `HOST` | `localhost` | Listening hostname |
| `PGBOSS_PROXY_INSTANCE_NAME` | `pg-boss-proxy` | Name in the instance registry, used when `instanceName` is not passed |
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

### PgBoss constructor options

Pass any PgBoss constructor options in the `options` object:

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

By default, the proxy sets `supervise`, `schedule` and `migrate` to `false` so it runs stateless. Set any of them to `true` to turn that feature on.

The proxy registers in the [instance registry](./api/ops.md#getinstances-options) as `pg-boss-proxy`. Pass `instanceName`, or set `PGBOSS_PROXY_INSTANCE_NAME`, to name each deployment.

### Authentication

Turn on basic auth with environment variables:

```bash
PGBOSS_PROXY_AUTH_USERNAME=admin
PGBOSS_PROXY_AUTH_PASSWORD=secret
```

Set both variables or neither. Auth then applies to every route under the prefix (`/api/*`, for example). The root page (`/`), the Swagger docs (`/docs`) and the OpenAPI spec (`/openapi.json`) sit outside the prefix and stay public.

### CORS

Turn on CORS with environment variables:

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

When `PGBOSS_PROXY_CORS_ORIGIN` is set, the proxy applies CORS middleware to every route under the prefix. The root page and docs don't get it.

### Custom middleware

Add your own Hono middleware to the API routes:

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

### Authorizing each call

`middleware` runs before every route under the prefix and doesn't know which method was called. The proxy calls `authorize` for each API request with the pg-boss method name, so you can grant access by method and by caller:

```ts
const { app, boss } = await createProxyService({
  options: { connectionString: 'postgres://user:pass@host/database' },
  middleware: [identifyCaller],
  authorize: async (context, method) => {
    const caller = context.get('caller')
    if (!caller) {
      context.header('WWW-Authenticate', 'Bearer')
      return { status: 401, message: 'Missing or invalid token' }
    }
    return caller.methods.includes(method)
  }
})
```

- It runs after `middleware`, so it sees anything a middleware set on the context. It runs before the proxy validates the request body or query.
- Return `true` to let the call through. `false` refuses it with `403 Forbidden`, and `{ status, message }` refuses it with that status. Anything else, including returning nothing, refuses the call with `403`.
- The refusal keeps any headers you set on the context before returning, such as `WWW-Authenticate`.
- `/meta` is authorized as the method `meta`. The root page, the docs and the OpenAPI spec aren't API routes, so they never reach it.
- A hook that throws answers `500`, with the message only when `exposeErrors` is on.
- Methods removed by `routes.allow` or `routes.deny` have no route, so they answer `404` before `authorize` is called.

### Mounting several services

`app` is a Hono app, so you can mount it in another one with `route()`. Each service wraps its own `PgBoss` instance, so one parent app can serve several databases:

```ts
import { Hono } from 'hono'
import { createProxyService } from '@pg-boss/proxy'

const parent = new Hono()

for (const [name, connectionString] of Object.entries(databases)) {
  const { app, boss } = await createProxyService({
    options: { connectionString },
    prefix: '',
    env: {}
  })
  await boss.start()
  parent.route(`/db/${name}`, app)
}
```

- With `prefix: ''`, a database's methods are at `/db/<name>/send` and so on. With the default prefix they're at `/db/<name>/api/send`.
- The root page, the docs and the OpenAPI spec are served under the mount too (`/db/<name>/docs`) and link through it. The spec lists the mount as its server, so the docs' **Try it out** calls the right database.
- `env: {}` keeps every service from reading `PGBOSS_PROXY_*` variables and `DATABASE_URL` from the process, which would otherwise apply to all of them.
- Each service has its own `stop()`. Call each one when the parent shuts down.

### Custom PgBoss factory

To wrap or change pg-boss behavior, pass a `bossFactory` function:

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

### Route filtering

Allowlist or denylist pg-boss methods to control which API routes the proxy exposes:

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

### Disabling pages

Turn off the root page, the docs or the OpenAPI spec:

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

## API reference

- `http://localhost:3000/docs`: Swagger UI for exploring all endpoints
- `http://localhost:3000/openapi.json`: machine-readable OpenAPI specification

## Contributing

To work on the proxy from source, see the [package README](https://github.com/timgit/pg-boss/blob/master/packages/proxy/README.md#running-from-source).
