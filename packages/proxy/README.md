# @pg-boss/proxy

HTTP proxy for pg-boss methods with a generated OpenAPI contract.

## Entry points

This package ships a runtime-neutral entry point and a Node-only entry point.

### Runtime-neutral (default)

Use this when you want a runtime-neutral entry point. Provide `DATABASE_URL` via `env` or pass PgBoss constructor options.

```ts
import { createProxyService } from '@pg-boss/proxy'

const { app, start, stop } = createProxyService({
  env: { DATABASE_URL: 'postgres://user:pass@host/database' }
})

await start()
// later
await stop()
```

If you only need the Hono app and will manage lifecycle yourself, use `createProxyApp`:

```ts
import { createProxyApp } from '@pg-boss/proxy'

const { app } = createProxyApp({
  env: { DATABASE_URL: 'postgres://user:pass@host/database' }
})
```

### Node convenience entry point

Use this if you want `process.env.DATABASE_URL` / connection options wiring.

```ts
import { createProxyServiceNode } from '@pg-boss/proxy/node'

const { app, start, stop } = createProxyServiceNode()

await start()
// later
await stop()
```

If you want a ready-to-listen Node server with signal wiring:

```ts
import { createProxyServerNode } from '@pg-boss/proxy/node'

const proxy = createProxyServerNode()
await proxy.start()
```

You can override environment lookups by passing an `env` object:

```ts
const proxy = createProxyServerNode({
  env: {
    DATABASE_URL: 'postgres://user:pass@host/database',
    PGBOSS_PROXY_PREFIX: '/custom',
    HOST: '0.0.0.0',
    PORT: '8080'
  }
})
```

## Lifecycle wiring by runtime

You can reuse the same shutdown wiring API across runtimes by passing the local signal adapter.

### Node

```ts
import { attachShutdownListeners, createProxyService, nodeShutdownAdapter } from '@pg-boss/proxy'

const { app, start, stop } = createProxyService({
  env: process.env
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], nodeShutdownAdapter, stop)
```

### Deno

```ts
import { attachShutdownListeners, createDenoShutdownAdapter, createProxyService } from '@pg-boss/proxy'

const { start, stop } = createProxyService({
  env: {
    DATABASE_URL: Deno.env.get('DATABASE_URL'),
    PGBOSS_PROXY_PREFIX: Deno.env.get('PGBOSS_PROXY_PREFIX')
  }
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], createDenoShutdownAdapter(), stop)
```

### Bun

```ts
import { attachShutdownListeners, createProxyService, bunShutdownAdapter } from '@pg-boss/proxy'

const { start, stop } = createProxyService({
  env: process.env
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], bunShutdownAdapter, stop)
```

### Long-lived runtimes only

`pg-boss` maintains a PostgreSQL connection pool via `pg`, so the proxy should be deployed on long-lived runtimes (Node, Deno, Bun).

### Prefix configuration

All runtimes can configure the API prefix with the `PGBOSS_PROXY_PREFIX` env var. For runtimes without `process.env`, pass `env` explicitly:

```ts
const { app } = createProxyApp({
  env: {
    DATABASE_URL: 'postgres://user:pass@host/database',
    PGBOSS_PROXY_PREFIX: '/custom'
  }
})
```

### Route filtering

You can allowlist or denylist pg-boss methods to control which API routes are exposed. `allow` is applied first, then `deny`.

```ts
const { app } = createProxyApp({
  env: { DATABASE_URL: 'postgres://user:pass@host/database' },
  routes: {
    allow: ['send', 'fetch', 'complete'],
    deny: ['deleteAllJobs']
  }
})
```

## Running the proxy server (Node)

```bash
DATABASE_URL=postgres://user:pass@host/database npm run dev
```
