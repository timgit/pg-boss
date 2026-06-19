# Proxy

An HTTP proxy is available in the [`@pg-boss/proxy`](https://www.npmjs.com/package/@pg-boss/proxy) package, exposing pg-boss methods over a simple JSON API. It's useful for platform compatibility (calling pg-boss from non-Node runtimes or serverless functions) and for connection pooling and scalability.

By default the proxy runs statelessly — job supervision, scheduling, and migrations are all disabled, so it only opens a database connection and serves requests.

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
```

All endpoints return a consistent JSON envelope:

```json
// Success
{ "ok": true, "result": <value | null> }

// Error
{ "ok": false, "error": { "message": "..." } }
```

## Configuration

The proxy can be configured via code options or environment variables. Code options take precedence when both are set. The most common environment variables are:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | - |
| `PORT` | Listening port | `3000` |
| `HOST` | Listening hostname | `localhost` |
| `PGBOSS_PROXY_PREFIX` | URL prefix for API routes | `/api` |
| `PGBOSS_PROXY_AUTH_USERNAME` | Basic auth username (set with password) | - |
| `PGBOSS_PROXY_AUTH_PASSWORD` | Basic auth password (set with username) | - |
| `PGBOSS_PROXY_CORS_ORIGIN` | CORS allowed origins (comma-separated or `*`) | - |

## Full Documentation

For complete documentation including code options, route filtering, custom middleware, deployment with Docker, and shutdown wiring for Deno and Bun, see the [full proxy README](https://github.com/timgit/pg-boss/blob/master/packages/proxy/README.md).
