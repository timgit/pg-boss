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
export function splitEnvList (value: string, separator: string): string[] {
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

const ALLOWED_ACTION_ORIGINS_ENV = 'PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS'

/**
 * Parse PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS, a comma-separated host list for
 * `allowedActionOrigins`. Returns `undefined` when unset or blank.
 * Throws on an entry `normalizeAllowedActionOrigins` rejects.
 */
export function parseAllowedActionOrigins (): string[] | undefined {
  const hosts = normalizeAllowedActionOrigins(
    splitEnvList(process.env[ALLOWED_ACTION_ORIGINS_ENV] ?? '', ','),
    ALLOWED_ACTION_ORIGINS_ENV
  )

  return hosts.length ? hosts : undefined
}

/**
 * Check and normalize `allowedActionOrigins` entries into the host form browsers send in
 * `Origin`: lowercase, punycode, canonical IP. `host:80` and `host:443` also add `host`.
 * Throws on a value that is not a list of strings, on an unsupported entry, and on `*`, `**`
 * or a wildcard over one label like `*.com`. `source` names the setting in the error.
 */
export function normalizeAllowedActionOrigins (entries: unknown, source: string): string[] {
  if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) {
    throw new Error(`${source} must be an array of host strings`)
  }

  return [...new Set(entries.flatMap(entry => toAllowedHosts(entry, source)))]
}

function toAllowedHosts (entry: string, source: string): string[] {
  const fail = (reason: string) => new Error(`${source} entry "${entry}" ${reason}`)
  const notAHost = () => fail('is not a host. Use host[:port] or *.example.com, without a scheme or path.')

  // An optional leading `*.` or `**.`, then a host (bracketed for IPv6), then an optional port.
  const parts = /^(?:(\*\*?)\.)?(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$/.exec(entry.toLowerCase())
  if (!parts) throw notAHost()
  const [, wildcard, host, port] = parts

  if (host.includes('*')) {
    if (host.split('.').every(label => label === '*' || label === '**')) {
      throw fail('matches too many hosts and would turn off the cross-site check. Name a domain, as in *.example.com.')
    }
    throw fail('is not supported. Use * or ** only as the whole first label, as in *.example.com.')
  }
  if (/[/?#@\\\s]/.test(host) || !URL.canParse(`http://${host}`)) throw notAHost()
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw notAHost()

  // URL does what the browser does to the Origin host: punycode, IPv4 and IPv6 canonical forms.
  const hostname = new URL(`http://${host}`).hostname
  const isIp = hostname.startsWith('[') || /^[\d.]+$/.test(hostname)

  if (!isIp && hostname.split('.').includes('')) {
    throw fail('has an empty label, so it never matches. Remove the leading, trailing or doubled dot.')
  }
  if (wildcard) {
    if (isIp) throw fail('puts a wildcard in front of an IP address, which never matches. Name a domain.')
    if (!hostname.includes('.')) {
      throw fail(`matches too many hosts: it covers every host under .${hostname}. Name a domain under it, as in *.example.${hostname}.`)
    }
  }

  const bare = (wildcard ? `${wildcard}.` : '') + hostname
  if (port === undefined) return [bare]

  // Origin drops a port only when it is the default for its own scheme, so keep the port
  // and allow the bare host too: `host:443` covers https://host and http://host:443.
  const portNumber = Number(port)
  const withPort = `${bare}:${portNumber}`
  return portNumber === 80 || portNumber === 443 ? [bare, withPort] : [withPort]
}
