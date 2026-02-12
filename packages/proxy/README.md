# @pg-boss/proxy

HTTP proxy for pg-boss methods with a generated OpenAPI contract.

## Entry points

This package ships a runtime-neutral entry point and a Node-only entry point.

### Runtime-neutral (default)

Use this when you want a runtime-neutral entry point. Provide PgBoss constructor options.

```ts
import { createProxyApp } from '@pg-boss/proxy'

const { app } = createProxyApp({
  options: { connectionString: 'postgres://user:pass@host/database' },
  prefix: '/api'
})
```

If you want standardized lifecycle hooks, use the service wrapper:

```ts
import { createProxyService } from '@pg-boss/proxy'

const { app, start, stop } = createProxyService({
  options: { connectionString: 'postgres://user:pass@host/database' },
  prefix: '/api'
})

await start()
// later
await stop()
```

### Node convenience entry point

Use this if you want `process.env.DATABASE_URL` / connection options wiring.

```ts
import { createProxyServiceNode } from '@pg-boss/proxy/node'

const { app, start, stop } = createProxyServiceNode({
  connectionString: process.env.DATABASE_URL,
  prefix: '/api'
})

await start()
// later
await stop()
```

## Lifecycle wiring by runtime

You can reuse the same shutdown wiring API across runtimes by passing the local signal adapter.

### Node

```ts
import { attachShutdownListeners, createProxyService } from '@pg-boss/proxy'

const { app, start, stop } = createProxyService({
  options: { connectionString: process.env.DATABASE_URL },
  prefix: '/api'
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], process, stop)
```

### Deno

```ts
import { attachShutdownListeners, createProxyService } from '@pg-boss/proxy'

const { start, stop } = createProxyService({
  options: { connectionString: Deno.env.get('DATABASE_URL') },
  prefix: '/api'
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], {
  on: (signal, handler) => Deno.addSignalListener(signal, handler),
  off: (signal, handler) => Deno.removeSignalListener(signal, handler)
}, stop)
```

### Bun

```ts
import { attachShutdownListeners, createProxyService } from '@pg-boss/proxy'

const { start, stop } = createProxyService({
  options: { connectionString: process.env.DATABASE_URL },
  prefix: '/api'
})

await start()

attachShutdownListeners(['SIGINT', 'SIGTERM'], process, stop)
```

### Long-lived runtimes only

`pg-boss` maintains a PostgreSQL connection pool via `pg`, so the proxy should be deployed on long-lived runtimes (Node, Deno, Bun). Edge/serverless runtimes are not suitable for maintaining pooled connections.

## Running the proxy server (Node)

```bash
DATABASE_URL=postgres://user:pass@host/database npm run dev
```
