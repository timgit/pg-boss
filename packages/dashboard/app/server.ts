import { createHonoServer } from 'react-router-hono-server/node'

declare module 'react-router' {
  interface AppLoadContext {
    readonly DB_URL: string;
    readonly SCHEMA: string;
  }
}

export default createHonoServer({
  getLoadContext () {
    return {
      DB_URL: process.env.DATABASE_URL || 'postgres://localhost/pgboss',
      SCHEMA: process.env.PGBOSS_SCHEMA || 'pgboss',
    }
  },
})
