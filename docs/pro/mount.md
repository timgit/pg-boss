# Mount in your application

An existing Node server can run Pro as a route without a second process. Install `@pg-boss/pro` in the application's own project, after setting up its `.npmrc` as in [Install](./install.md#install). The application then serves Pro from a route of its own:

```ts
import { getConnInfo } from '@hono/node-server/conninfo'
import { createDashboardHandler } from '@pg-boss/pro/handler'

const dashboard = createDashboardHandler({
  basePath: '/admin/queues',
})

const serve = (c) => dashboard(c.req.raw, { clientIp: getConnInfo(c).remote.address })

app.all('/admin/queues', serve)
app.all('/admin/queues.data', serve)
app.all('/admin/queues/*', serve)
```

- The example is a Hono app served by `@hono/node-server`, which the application installs to serve it. `getConnInfo` comes from that same package.
- Route `<basePath>.data` as well as `<basePath>/*`. The `.data` route sits next to the mount path, outside `<basePath>/*`. Without it, the Home link returns 404.
- Pro authenticates on this path exactly as it does standalone. Pro's accounts apply whatever else the application does in front of the route.
- Pass each request's address as `clientIp`, as above. Pro limits failed sign-ins per address and records the address in the [audit log](./audit-log.md#address). Without an address, failures are limited per account only, and Pro warns once on stderr. Behind a proxy, pass the address your server's own proxy setting resolves.
- A host that calls the handler through `@hono/node-server`'s `getRequestListener`, as the [Express example](../dashboard.md#mounting-inside-an-existing-application) does, needs no `clientIp`. Pro reads the connection as it does standalone, with [`PGBOSS_PRO_TRUSTED_PROXIES`](./environment.md#pgboss-pro-trusted-proxies).
- Set the [`PGBOSS_PRO_DB_` settings](./install.md#database-setup) in the application's environment. A mounted Pro keeps its tables in a database of its own, as a standalone one does.
- Call `close()` when the server shuts down. The standalone server handles `SIGTERM` itself; a mounted handler leaves signals to the host application.

The handler takes the same options as the [dashboard's](../dashboard.md#mounting-inside-an-existing-application), except `databases`. A mounted Pro monitors the schemas a global admin adds under **Settings › Schemas**, as a standalone Pro does.
