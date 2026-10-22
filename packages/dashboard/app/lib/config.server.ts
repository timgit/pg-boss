import type { PublicDatabase } from './types'

// Multi-database configuration support
// Format: "name1=postgres://host1/db1|name2=postgres://host2/db2"
// Or simply: "postgres://host1/db1|postgres://host2/db2" (names derived from database)

export interface DatabaseConfig {
  id: string;      // URL-safe identifier
  name: string;    // Display name
  url: string;     // Connection string
  schema: string;  // pg-boss schema
}

/**
 * Strip a database configuration down to what the browser is allowed to see.
 *
 * `url` is a connection string with a password in it. Anything a loader
 * returns is serialized into the SSR payload and readable in page source, so
 * the projection has to happen before the value leaves the server, not in the
 * component that renders it.
 */
export function toPublicDatabase ({ id, name, schema }: DatabaseConfig): PublicDatabase {
  return { id, name, schema }
}

const SEPARATOR = '|'
const DEFAULT_SCHEMA = 'pgboss'

/** Split an environment list on `separator`, trimming entries and dropping empty ones. */
function splitEnvList (value: string, separator: string): string[] {
  return value.split(separator).map(s => s.trim()).filter(Boolean)
}

/**
 * Parse DATABASE_URL and PGBOSS_SCHEMA environment variables
 * into a list of database configurations.
 */
export function parseDatabaseConfig (): DatabaseConfig[] {
  const dbUrlEnv = process.env.DATABASE_URL || 'postgres://localhost/pgboss'
  const schemaEnv = process.env.PGBOSS_SCHEMA || DEFAULT_SCHEMA

  const urlParts = splitEnvList(dbUrlEnv, SEPARATOR)
  const schemaParts = splitEnvList(schemaEnv, SEPARATOR)

  return urlParts.map((part, index) => {
    // Check for "name=url" format
    const equalsIndex = part.indexOf('=')

    // Only treat as name=url if = comes before :// (to avoid matching postgres://user:pass@)
    const protocolIndex = part.indexOf('://')
    if (equalsIndex > 0 && (protocolIndex === -1 || equalsIndex < protocolIndex)) {
      return toDatabaseConfig({
        name: part.substring(0, equalsIndex).trim(),
        url: part.substring(equalsIndex + 1).trim(),
        schema: schemaParts[index],
      }, index)
    }

    return toDatabaseConfig({ url: part, schema: schemaParts[index] }, index)
  })
}

export interface DatabaseInput {
  url: string;
  name?: string;
  schema?: string;
}

/** Shared by the environment parser above and by `createDashboardHandler()`. */
export function toDatabaseConfig ({ url, name, schema }: DatabaseInput, index: number): DatabaseConfig {
  const displayName = name || extractDatabaseName(url) || `Database ${index + 1}`

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
  return sanitized || `db-${index}`
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

/**
 * Parse PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS, a comma-separated host list for
 * `allowedActionOrigins`. Returns `undefined` when unset. Entries are lowercased and
 * lose a default port, to match the `Origin` host React Router compares them with.
 * Throws on an entry that could never match, or on a wildcard that matches any host.
 */
export function parseAllowedActionOrigins (): string[] | undefined {
  const hosts = splitEnvList(process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS ?? '', ',').map(toAllowedHost)

  return hosts.length ? hosts : undefined
}

function toAllowedHost (entry: string): string {
  const host = entry.toLowerCase().replace(/:(80|443)$/, '')
  const fail = (reason: string) => new Error(`PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS entry "${entry}" ${reason}`)

  // Swap each wildcard for a plain label so URL can check the rest is a bare host.
  const literal = host.replaceAll('*', 'w')
  if (!URL.canParse(`http://${literal}`) || new URL(`http://${literal}`).host !== literal) {
    throw fail('is not a host. Use host[:port] or *.example.com, without a scheme or path.')
  }

  const labels = host.replace(/:\d+$/, '').split('.')
  const wildcards = labels.filter(label => label === '*' || label === '**').length

  if (labels.slice(1).includes('**')) {
    throw fail('never matches: ** is only allowed as the first label, as in **.example.com.')
  }
  if (wildcards > 0 && labels.length - wildcards < 2) {
    throw fail('matches too many hosts and would turn off the cross-site check. Name a domain, as in *.example.com.')
  }

  return host
}
