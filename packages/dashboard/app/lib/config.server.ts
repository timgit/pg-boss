// Multi-database configuration support
// Format: "name1=postgres://host1/db1|name2=postgres://host2/db2"
// Or simply: "postgres://host1/db1|postgres://host2/db2" (names derived from database)
//
// Alternatively, PGBOSS_DASHBOARD_CONFIG can point to a JS module exporting
// database entries with extra connection options (e.g. a password function
// for dynamic credentials like AWS RDS IAM auth) that are passed through to
// pg-boss and pg.

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { parse as parseConnectionString } from 'pg-connection-string'

// Extra connection options merged into the pg.Pool / pg-boss constructor
// config for a database. Notably `password` may be a function so credentials
// can be minted per connection (short-lived auth tokens).
export type ConnectionOptions = Record<string, unknown>

export interface DatabaseConfig {
  id: string;      // URL-safe identifier
  name: string;    // Display name
  url: string;     // Connection string
  schema: string;  // pg-boss schema
  options?: ConnectionOptions; // Extra pg / pg-boss connection options
}

export interface DatabaseConfigFileEntry {
  name?: string;
  url: string;
  schema?: string;
  options?: ConnectionOptions;
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
 * Load database configurations from a JS module (PGBOSS_DASHBOARD_CONFIG).
 * The module's default export is an array of entries with optional extra
 * connection options that can't be expressed in a connection string, such as
 * a password function for dynamically minted credentials.
 */
export async function loadConfigFile (path: string): Promise<DatabaseConfig[]> {
  let mod: { default?: DatabaseConfigFileEntry[] }
  try {
    mod = await import(/* @vite-ignore */ pathToFileURL(resolve(path)).href)
  } catch (err) {
    throw new Error(`Failed to load PGBOSS_DASHBOARD_CONFIG module at "${path}": ${err instanceof Error ? err.message : err}`)
  }

  const entries = mod.default
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`PGBOSS_DASHBOARD_CONFIG module at "${path}" must default-export a non-empty array of database entries`)
  }

  return entries.map((entry, index) => {
    if (!entry || typeof entry.url !== 'string' || !entry.url) {
      throw new Error(`PGBOSS_DASHBOARD_CONFIG entry at index ${index} is missing a "url"`)
    }
    const name = entry.name || extractDatabaseName(entry.url) || `Database ${index + 1}`
    return {
      id: generateId(name, index),
      name,
      url: entry.url,
      schema: entry.schema || DEFAULT_SCHEMA,
      options: entry.options,
    }
  })
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

// Config file entries (if any) are loaded once at startup so the rest of the
// app can keep reading configuration synchronously.
const configFilePath = process.env.PGBOSS_DASHBOARD_CONFIG
const fileConfigs: DatabaseConfig[] | null = configFilePath
  ? await loadConfigFile(configFilePath)
  : null

// Cached config to avoid re-parsing on every request
let cachedConfig: DatabaseConfig[] | null = null

export function getDatabaseConfigs (): DatabaseConfig[] {
  if (!cachedConfig) {
    cachedConfig = fileConfigs || parseDatabaseConfig()
  }
  return cachedConfig
}

/**
 * Build a pg connection config from a URL plus extra options. node-postgres
 * only honors a `password` function when discrete fields are used (it is
 * ignored alongside `connectionString`), so when options are present the URL
 * is parsed into fields and the options merged on top.
 */
export function buildConnectionConfig (
  url: string,
  options?: ConnectionOptions
): Record<string, unknown> {
  if (!options) {
    return { connectionString: url }
  }

  const parsed = parseConnectionString(url)
  const config: Record<string, unknown> = {
    host: parsed.host ?? undefined,
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.database ?? undefined,
    user: parsed.user ?? undefined,
    password: parsed.password ?? undefined,
    ssl: parsed.ssl ?? undefined,
  }
  for (const key of Object.keys(config)) {
    if (config[key] === undefined) delete config[key]
  }

  return { ...config, ...options }
}

/**
 * Connection config for a database, looked up by its connection string.
 * Used wherever a pool or pg-boss instance is created from a URL.
 */
export function getConnectionConfig (url: string): Record<string, unknown> {
  return buildConnectionConfig(url, getDatabaseConfigs().find(c => c.url === url)?.options)
}

// For testing - reset cache
export function resetConfigCache (): void {
  cachedConfig = null
}
