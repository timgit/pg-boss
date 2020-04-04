import assert from 'assert'
import { advisoryLock, assertMigration, setVersion, SchemaName, SchemaVersion } from './plans'

/**
 * Migration SQL statement.
*/
type MigrationCommand = string

export interface Migration {
  version: SchemaVersion
  previous: SchemaVersion
  install: MigrationCommand[]
  uninstall: MigrationCommand[]
}

export interface MigrationConfig {
  keepUntil?: string
  schema: SchemaName
  migrations?: Migration[]
}

function flatten (schema: SchemaName, commands: MigrationCommand[], version: SchemaVersion) {
  const preflight = [
    'BEGIN',
    advisoryLock(),
    assertMigration(schema, version)
  ]

  const postflight = [
    setVersion(schema, version),
    'COMMIT;'
  ]

  return [...preflight, ...commands, ...postflight].join(';')
}

export function rollback (schema: SchemaName, version: SchemaVersion, migrations = getAll(schema)) {
  const result = migrations.find(i => i.version === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.uninstall, result.previous)
}

export function next (schema: SchemaName, version: SchemaVersion, migrations = getAll(schema)) {
  const result = migrations.find(i => i.previous === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

export function migrate (value: MigrationConfig | SchemaName, version: SchemaVersion, migrations?: Migration[]) {
  let schema: SchemaName
  let config: MigrationConfig

  if (typeof value === 'string') {
    config = null
    schema = value
  } else {
    config = value
    schema = config.schema
  }

  migrations = migrations || getAll(schema, config)

  const result = migrations
    .filter(i => i.previous >= version)
    .sort((a, b) => a.version - b.version)
    .reduce((acc, i) => {
      acc.install = acc.install.concat(i.install)
      acc.version = i.version
      return acc
    }, { install: [] as MigrationCommand[], version })

  assert(result.install.length > 0, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

export function getAll (schema: SchemaName, config?: MigrationConfig): Migration[] {
  const DEFAULT_RETENTION = '30 days'
  const keepUntil = config ? config.keepUntil : DEFAULT_RETENTION

  return [
    {
      version: 12,
      previous: 11,
      install: [
          `ALTER TABLE ${schema}.version ALTER COLUMN version TYPE int USING version::int`,
          `ALTER TABLE ${schema}.job ADD COLUMN keepUntil timestamptz`,
          `ALTER TABLE ${schema}.archive ADD COLUMN keepUntil timestamptz`,
          `ALTER TABLE ${schema}.job ALTER COLUMN keepUntil SET DEFAULT now() + interval '${DEFAULT_RETENTION}'`,
          `UPDATE ${schema}.job SET keepUntil = startAfter + interval '${keepUntil}'`,
          `ALTER TABLE ${schema}.job ALTER COLUMN keepUntil SET NOT NULL`
      ],
      uninstall: [
          `ALTER TABLE ${schema}.version ALTER COLUMN version TYPE text USING version::text`,
          `ALTER TABLE ${schema}.job DROP COLUMN keepUntil`,
          `ALTER TABLE ${schema}.archive DROP COLUMN keepUntil`
      ]
    },
    {
      version: 11,
      previous: 10,
      install: [
          `CREATE INDEX archive_archivedon_idx ON ${schema}.archive(archivedon)`
      ],
      uninstall: [
          `DROP INDEX ${schema}.archive_archivedon_idx`
      ]
    },
    {
      version: 10,
      previous: 9,
      install: [
        `CREATE INDEX archive_id_idx ON ${schema}.archive(id)`
      ],
      uninstall: [
        `DROP INDEX ${schema}.archive_id_idx`
      ]
    },
    {
      version: 9,
      previous: 8,
      install: [
        `DROP INDEX ${schema}.job_fetch`,
        `DROP INDEX ${schema}.job_name`,
        `CREATE INDEX job_name ON ${schema}.job (name text_pattern_ops)`,
        `UPDATE ${schema}.job set name = '__state__completed__' || substr(name, 1, position('__state__completed' in name) - 1) WHERE name LIKE '%__state__completed'`
      ],
      uninstall: [
        `UPDATE ${schema}.job set name = substr(name, 21) || '__state__completed' WHERE name LIKE '__state__completed__%'`,
        `CREATE INDEX job_fetch ON ${schema}.job (name, priority desc, createdOn, id) WHERE state < 'active'`,
        `DROP INDEX ${schema}.job_name`,
        `CREATE INDEX job_name ON ${schema}.job (name) WHERE state < 'active'`
      ]
    }
  ]
}
