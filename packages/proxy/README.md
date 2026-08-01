# @pg-boss/proxy

An HTTP proxy for [pg-boss](https://github.com/timgit/pg-boss) methods, exposing them over a simple JSON API — useful for platform compatibility (calling pg-boss from non-Node runtimes or serverless functions) and for connection pooling and scalability.

All background processing (supervision, scheduling, migrations) is disabled by default, so the proxy runs statelessly: it only opens a database connection and serves requests.

📖 **[Read the full documentation →](https://pgboss.io/proxy)**

## Quick Start

```bash
npm install @pg-boss/proxy
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-proxy
```

Then visit:
- http://localhost:3000 — proxy home page with links to all endpoints
- http://localhost:3000/docs — interactive Swagger documentation
- http://localhost:3000/openapi.json — OpenAPI spec

Or embed it in your own Node app:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'

const proxy = await createProxyServerNode()
await proxy.start()
// Reads DATABASE_URL from process.env, listens on PORT (default 3000)
```

For the HTTP API, runtime-neutral entry points, shutdown wiring (Node/Deno/Bun), full configuration (code options and environment variables), route filtering, custom middleware, and deployment, see the [documentation](https://pgboss.io/proxy).

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

## License

MIT
