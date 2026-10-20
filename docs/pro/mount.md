# Mount in your application

An existing Node server can run Pro as a route, so it needs no second process:

```ts
import { createDashboardHandler } from '@pg-boss/pro/handler'

const dashboard = createDashboardHandler({
  databases: [{ url: process.env.DATABASE_URL, schema: 'pgboss' }],
  basePath: '/admin/queues',
})

app.all('/admin/queues', (c) => dashboard(c.req.raw))
app.all('/admin/queues.data', (c) => dashboard(c.req.raw))
app.all('/admin/queues/*', (c) => dashboard(c.req.raw))
```

- Route `<basePath>.data` as well as `<basePath>/*`. It sits next to the mount path, outside `<basePath>/*`, and without that route the Home link returns 404.
- Pro authenticates on this path exactly as it does standalone. Its accounts apply, whatever else the application does in front of it.
- Call `close()` when the server shuts down. The standalone server handles `SIGTERM` itself; a mounted handler leaves signals to the host application.

The handler takes the same options as the [free dashboard's](../dashboard.md#mounting-inside-an-existing-application).
