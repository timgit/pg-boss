# Mount in your application

If you already run a Node server, Pro can run as a route in it, so you don't need a second process:

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
- Pro authenticates on this path exactly as it does standalone. Its accounts apply, whatever else your application does in front of it.
- Call `close()` when your server shuts down. The standalone server handles `SIGTERM` itself; a mounted handler leaves signals to you.

The handler takes the same options as the [free dashboard's](../dashboard.md#mounting-inside-an-existing-application).
