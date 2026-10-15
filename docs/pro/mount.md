# Mount in your application

If you already run a Node server, Pro can be a route in it rather than a second process:

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

- Route `<basePath>.data` as well as `<basePath>/*`. It is a sibling of the mount path, not a child, and without it the Home link answers 404.
- Pro authenticates on this path exactly as it does standalone. Its accounts apply, whatever else your application does in front of it.
- Call `close()` when your server shuts down. The standalone server handles `SIGTERM` itself; a mounted handler leaves signals to you.

The handler takes the same options as the [free dashboard's](../dashboard.md#mounting-inside-an-existing-application).
