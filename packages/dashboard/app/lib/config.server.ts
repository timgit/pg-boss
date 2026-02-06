// Multi-database configuration support
// Format: "name1=postgres://host1/db1|name2=postgres://host2/db2"
// Or simply: "postgres://host1/db1|postgres://host2/db2" (names derived from database)

export interface DatabaseConfig {
  id: string;      // URL-safe identifier
  name: string;    // Display name
  url: string;     // Connection string
  schema: string;  // pg-boss schema
}

const SEPARATOR = '|'
const DEFAULT_SCHEMA = 'pgboss'

/**
 * Parse DATABASE_URL and PGBOSS_SCHEMA environment variables
 * into a list of database configurations.
 */
export function parseDatabaseConfig (): DatabaseConfig[] {
  const dbUrlEnv = process.env.DATABASE_URL || 'postgres://localhost/pgboss'
  const schemaEnv = process.env.PGBOSS_SCHEMA || DEFAULT_SCHEMA

  const urlParts = dbUrlEnv.split(SEPARATOR).map(s => s.trim()).filter(Boolean)
  const schemaParts = schemaEnv.split(SEPARATOR).map(s => s.trim()).filter(Boolean)

  return urlParts.map((part, index) => {
    // Check for "name=url" format
    const equalsIndex = part.indexOf('=')
    let name: string
    let url: string

    // Only treat as name=url if = comes before :// (to avoid matching postgres://user:pass@)
    const protocolIndex = part.indexOf('://')
    if (equalsIndex > 0 && (protocolIndex === -1 || equalsIndex < protocolIndex)) {
      name = part.substring(0, equalsIndex).trim()
      url = part.substring(equalsIndex + 1).trim()
    } else {
      url = part
      name = extractDatabaseName(url) || `Database ${index + 1}`
    }

    const schema = schemaParts[index] || DEFAULT_SCHEMA
    const id = generateId(name, index)

    return { id, name, url, schema }
  })
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
