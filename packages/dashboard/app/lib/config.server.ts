import type { PublicDatabase } from './types'
import type { DatabaseColor } from './database-colors'

// Each `DATABASE_URL` entry is one schema: "Production=postgres://host/db?schema=jobs|postgres://host2/db2".
// The name before `=` and `?schema=` are both optional.

export interface DatabaseConfig {
  id: string;      // URL-safe identifier
  name: string;    // Display name
  url: string;     // Connection string
  schema: string;  // pg-boss schema
  color?: DatabaseColor; // Set by an overlay; otherwise one is picked by position
  badge?: string;  // A short label beside the name in the switcher, set by an overlay
}

/**
 * Strip a database configuration down to what the browser is allowed to see.
 *
 * `url` is a connection string with a password in it. Anything a loader
 * returns is serialized into the SSR payload and readable in page source, so
 * the projection has to happen before the value leaves the server, not in the
 * component that renders it.
 */
export function toPublicDatabase ({ id, name, schema, color, badge }: DatabaseConfig): PublicDatabase {
  return { id, name, schema, ...(color ? { color } : {}), ...(badge ? { badge } : {}) }
}

const SEPARATOR = '|'
const DEFAULT_SCHEMA = 'pgboss'

/** Split an environment list on `separator`, trimming entries and dropping empty ones. */
export function splitEnvList (value: string, separator: string): string[] {
  return value.split(separator).map(s => s.trim()).filter(Boolean)
}

/**
 * Parse DATABASE_URL into a list of schemas: entries split on `|`, each an optional `Name=` and a
 * connection string with an optional `?schema=`. An entry without one reads `PGBOSS_SCHEMA`, as
 * pg-boss's CLI does, or `pgboss`.
 *
 * `PGBOSS_SCHEMA` is how a host that sets `DATABASE_URL` itself, as an attached database does, names
 * the schema without an edit to that variable that the host may overwrite.
 */
export function parseDatabaseConfig (): DatabaseConfig[] {
  const dbUrlEnv = process.env.DATABASE_URL || 'postgres://localhost/pgboss'
  const defaultSchema = process.env.PGBOSS_SCHEMA?.trim() || undefined

  return distinctIds(splitEnvList(dbUrlEnv, SEPARATOR).map((part, index) => {
    // Check for "name=url" format
    const equalsIndex = part.indexOf('=')

    // Only treat as name=url if = comes before :// (to avoid matching postgres://user:pass@)
    const protocolIndex = part.indexOf('://')
    const named = equalsIndex > 0 && (protocolIndex === -1 || equalsIndex < protocolIndex)
    const name = named ? part.substring(0, equalsIndex).trim() : undefined
    const { url, schema } = takeSchema(named ? part.substring(equalsIndex + 1).trim() : part)

    return toDatabaseConfig({ name, url, schema: schema ?? defaultSchema }, index)
  }))
}

/**
 * Take `schema` out of a connection string's query, because libpq refuses a parameter it doesn't
 * know. The other parameters, such as `sslmode`, stay as written.
 */
export function takeSchema (connection: string): { url: string, schema?: string } {
  const query = connection.indexOf('?')
  if (query === -1) return { url: connection }

  let schema: string | undefined
  const rest = connection.slice(query + 1).split('&').filter((pair) => {
    if (!pair.startsWith('schema=')) return true
    schema = decodeURIComponent(pair.slice('schema='.length)) || undefined
    return false
  })
  const base = connection.slice(0, query)

  return { url: rest.length > 0 ? `${base}?${rest.join('&')}` : base, schema }
}

/**
 * Tell apart two entries that would share an id, as two schemas in one database do when neither
 * is named. The first keeps its id; a later one takes its schema into its id and
 * name. Shared, an id would scope a role to both and leave the second unreachable from the switcher.
 */
function distinctIds (configs: DatabaseConfig[]): DatabaseConfig[] {
  const taken = new Set<string>()

  return configs.map((config, index) => {
    if (!taken.has(config.id)) {
      taken.add(config.id)
      return config
    }

    let id = generateId(`${config.name}-${config.schema}`, index)
    if (taken.has(id)) id = `${id}-${index + 1}`
    taken.add(id)

    return { ...config, id, name: `${config.name} (${config.schema})` }
  })
}

export interface DatabaseInput {
  url: string;
  name?: string;
  schema?: string;
}

/** Shared by the environment parser above and by `createDashboardHandler()`. */
export function toDatabaseConfig ({ url, name, schema }: DatabaseInput, index: number): DatabaseConfig {
  const displayName = name || extractDatabaseName(url) || `Schema ${index + 1}`

  return {
    id: generateId(displayName, index),
    name: displayName,
    url,
    schema: schema || DEFAULT_SCHEMA,
  }
}

/**
 * Extract database name from connection string for display
 */
function extractDatabaseName (url: string): string | null {
  try {
    // Handle postgres:// URLs
    const match = url.match(/\/([^/?]+)(?:\?|$)/)
    if (match) {
      return match[1]
    }
    return null
  } catch {
    return null
  }
}

/**
 * Generate a URL-safe ID from the name
 */
function generateId (name: string, index: number): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return sanitized || `schema-${index}`
}

/**
 * Find a database config by ID
 */
export function findDatabaseById (
  configs: DatabaseConfig[],
  id: string | null
): DatabaseConfig | null {
  if (!id) return configs[0] || null
  return configs.find(c => c.id === id) || configs[0] || null
}

// Cached config to avoid re-parsing on every request
let cachedConfig: DatabaseConfig[] | null = null

export function getDatabaseConfigs (): DatabaseConfig[] {
  if (!cachedConfig) {
    cachedConfig = parseDatabaseConfig()
  }
  return cachedConfig
}

// For testing - reset cache
export function resetConfigCache (): void {
  cachedConfig = null
}

const SITE_URL_ENV = 'PGBOSS_DASHBOARD_SITE_URL'

/**
 * Parse PGBOSS_DASHBOARD_SITE_URL, the public origin a proxy serves the dashboard at.
 * Returns `undefined` when unset or blank.
 */
export function parseSiteUrl (): string | undefined {
  const value = process.env[SITE_URL_ENV]?.trim()

  return value ? toSiteOrigin(value, SITE_URL_ENV) : undefined
}

/**
 * Check a site URL and return its origin. Throws on anything but `http(s)://host[:port]`:
 * the path comes from the base path instead. `source` names the setting in the error.
 */
export function toSiteOrigin (value: string, source: string): string {
  const fail = () => new Error(
    `${source} "${value}" is not a site URL. Use https://host[:port], without a path. ` +
    'The base path sets the path.'
  )

  if (!URL.canParse(value)) throw fail()
  const url = new URL(value)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail()
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail()

  return url.origin
}
