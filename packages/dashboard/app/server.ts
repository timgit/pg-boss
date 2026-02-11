import { createHonoServer } from 'react-router-hono-server/node'
import { configureAuth } from './lib/auth.server'
import { getDatabaseConfigs, findDatabaseById, type DatabaseConfig } from './lib/config.server'

declare module 'react-router' {
  interface AppLoadContext {
    readonly databases: DatabaseConfig[];
    readonly currentDb: DatabaseConfig;
    // Convenience accessors for current database
    readonly DB_URL: string;
    readonly SCHEMA: string;
  }
}

export default createHonoServer({
  beforeAll (app) {
    configureAuth(app)
  },
  getLoadContext (c) {
    const databases = getDatabaseConfigs()

    // Get selected database from query param or cookie
    const url = new URL(c.req.url)
    const dbId = url.searchParams.get('db') || c.req.header('cookie')?.match(/pgboss_db=([^;]+)/)?.[1] || null
    const currentDb = findDatabaseById(databases, dbId) || databases[0]

    return {
      databases,
      currentDb,
      // Backwards-compatible accessors
      DB_URL: currentDb?.url || 'postgres://localhost/pgboss',
      SCHEMA: currentDb?.schema || 'pgboss',
    }
  },
})
