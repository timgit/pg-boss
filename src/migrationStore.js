const assert = require('assert')
const plans = require('./plans')

module.exports = {
  rollback,
  next,
  migrate,
  getAll
}

function flatten (schema, commands, version) {
  const preflight = [
    'BEGIN',
    plans.advisoryLock(),
    plans.assertMigration(schema, version)
  ]

  const postflight = [
    plans.setVersion(schema, version),
    'COMMIT;'
  ]

  commands = preflight.concat(commands).concat(postflight)

  return commands.join(';')
}

function rollback (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.version === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.uninstall, result.previous)
}

function next (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.previous === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

function migrate (value, version, migrations) {
  let schema, config

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
    }, { install: [], version })

  assert(result.install.length > 0, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

function getAll (schema, config) {
  const DEFAULT_RETENTION = '30 days'
  const keepUntil = config ? config.keepUntil : DEFAULT_RETENTION

  return [
    {
      release: '5.0.6',
      version: 15,
      previous: 14,
      install: [
          `ALTER TABLE ${schema}.version ADD cron_on timestamp with time zone`
      ],
      uninstall: [
          `ALTER TABLE ${schema}.version DROP COLUMN cron_on`
      ]
    },
    {
      release: '5.0.0',
      version: 14,
      previous: 13,
      install: [
          `ALTER TABLE ${schema}.version ADD maintained_on timestamp with time zone`
      ],
      uninstall: [
          `ALTER TABLE ${schema}.version DROP COLUMN maintained_on`
      ]
    },
    {
      release: '5.0.0-beta1',
      version: 13,
      previous: 12,
      install: [
          `CREATE TABLE ${schema}.schedule (
            name text primary key,
            cron text not null,
            timezone text,
            data jsonb,
            options jsonb,
            created_on timestamp with time zone not null default now(),
            updated_on timestamp with time zone not null default now()
          )`
      ],
      uninstall: [
          `DROP TABLE ${schema}.schedule`
      ]
    },
    {
      release: '4.0.0',
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
      release: '3.2.0',
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
      release: '3.1.3',
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
      release: '3.1.0',
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
    },
    {
      release: '3.0.0',
      version: 8,
      previous: 7,
      install: [
        'CREATE EXTENSION IF NOT EXISTS pgcrypto',
        `ALTER TABLE ${schema}.job ALTER COLUMN id SET DEFAULT gen_random_uuid()`,
        `ALTER TABLE ${schema}.job ADD retryDelay integer not null DEFAULT (0)`,
        `ALTER TABLE ${schema}.job ADD retryBackoff boolean not null DEFAULT false`,
        `ALTER TABLE ${schema}.job ADD startAfter timestamp with time zone not null default now()`,
        `UPDATE ${schema}.job SET startAfter = createdOn + startIn`,
        `ALTER TABLE ${schema}.job DROP COLUMN startIn`,
        `UPDATE ${schema}.job SET expireIn = interval '15 minutes' WHERE expireIn IS NULL`,
        `ALTER TABLE ${schema}.job ALTER COLUMN expireIn SET NOT NULL`,
        `ALTER TABLE ${schema}.job ALTER COLUMN expireIn SET DEFAULT interval '15 minutes'`,
        // archive table schema changes
        `ALTER TABLE ${schema}.archive ADD retryDelay integer not null DEFAULT (0)`,
        `ALTER TABLE ${schema}.archive ADD retryBackoff boolean not null DEFAULT false`,
        `ALTER TABLE ${schema}.archive ADD startAfter timestamp with time zone`,
        `UPDATE ${schema}.archive SET startAfter = createdOn + startIn`,
        `ALTER TABLE ${schema}.archive DROP COLUMN startIn`,
        // rename complete to completed for state enum - can't use ALTER TYPE :(
        `DROP INDEX ${schema}.job_fetch`,
        `DROP INDEX ${schema}.job_singletonOn`,
        `DROP INDEX ${schema}.job_singletonKeyOn`,
        `DROP INDEX ${schema}.job_singletonKey`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state DROP DEFAULT`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE text USING state::text`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state SET DATA TYPE text USING state::text`,
        `DROP TYPE ${schema}.job_state`,
        `CREATE TYPE ${schema}.job_state AS ENUM ('created', 'retry', 'active', 'completed', 'expired', 'cancelled', 'failed')`,
        `UPDATE ${schema}.job SET state = 'completed' WHERE state = 'complete'`,
        `UPDATE ${schema}.archive SET state = 'completed' WHERE state = 'complete'`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DEFAULT 'created'`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `CREATE INDEX job_fetch ON ${schema}.job (name, priority desc, createdOn, id) WHERE state < 'active'`,
        `CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < 'expired' AND singletonKey IS NULL`,
        `CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < 'expired'`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL`,
        // add new job name index
        `CREATE INDEX job_name ON ${schema}.job (name) WHERE state < 'active'`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job ALTER COLUMN id DROP DEFAULT`,
        // won't know if we should drop pgcrypto extension so it stays
        `ALTER TABLE ${schema}.job DROP COLUMN retryDelay`,
        `ALTER TABLE ${schema}.job DROP COLUMN retryBackoff`,
        `ALTER TABLE ${schema}.job DROP COLUMN startAfter`,
        `ALTER TABLE ${schema}.job ADD COLUMN startIn interval not null default(interval '0')`,
        // leaving migrated default data for expireIn
        `ALTER TABLE ${schema}.job ALTER COLUMN expireIn DROP NOT NULL`,
        `ALTER TABLE ${schema}.job ALTER COLUMN expireIn DROP DEFAULT`,
        // archive table restore
        `ALTER TABLE ${schema}.archive DROP COLUMN retryDelay`,
        `ALTER TABLE ${schema}.archive DROP COLUMN retryBackoff`,
        `ALTER TABLE ${schema}.archive DROP COLUMN startAfter`,
        `ALTER TABLE ${schema}.archive ADD COLUMN startIn interval`,
        // drop new job name index
        `DROP INDEX ${schema}.job_name`,
        // roll back to old enum def
        `DROP INDEX ${schema}.job_fetch`,
        `DROP INDEX ${schema}.job_singletonOn`,
        `DROP INDEX ${schema}.job_singletonKeyOn`,
        `DROP INDEX ${schema}.job_singletonKey`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state DROP DEFAULT`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE text USING state::text`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state SET DATA TYPE text USING state::text`,
        `DROP TYPE ${schema}.job_state`,
        `CREATE TYPE ${schema}.job_state AS ENUM ('created', 'retry', 'active', 'complete', 'expired', 'cancelled', 'failed')`,
        `UPDATE ${schema}.job SET state = 'completed' WHERE state = 'complete'`,
        `UPDATE ${schema}.archive SET state = 'complete' WHERE state = 'completed'`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DEFAULT 'created'`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `CREATE INDEX job_fetch ON ${schema}.job (name, priority desc, createdOn, id) WHERE state < 'active'`,
        `CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < 'expired' AND singletonKey IS NULL`,
        `CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < 'expired'`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'complete' AND singletonOn IS NULL`
      ]
    },
    {
      release: '2.5.0',
      version: 7,
      previous: 6,
      install: [
        `CREATE TABLE IF NOT EXISTS ${schema}.archive (LIKE ${schema}.job)`,
        `ALTER TABLE ${schema}.archive ADD archivedOn timestamptz NOT NULL DEFAULT now()`
      ],
      uninstall: [
        `DROP TABLE ${schema}.archive`
      ]
    },
    {
      release: '2.0.0',
      version: 6,
      previous: 5,
      install: [
        `CREATE INDEX job_fetch ON ${schema}.job (priority desc, createdOn, id) WHERE state < 'active'`
      ],
      uninstall: [
        `DROP INDEX ${schema}.job_fetch`
      ]
    },
    {
      release: '2.0.0',
      version: 5,
      previous: 4,
      install: [
        `ALTER TABLE ${schema}.job ALTER COLUMN startIn SET DEFAULT (interval '0')`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DEFAULT ('created')`,
        `UPDATE ${schema}.job SET name = left(name, -9) || '__state__expired' WHERE name LIKE '%__expired'`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job ALTER COLUMN startIn DROP DEFAULT`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state DROP DEFAULT`,
        `UPDATE ${schema}.job SET name = left(name, -16) || '__expired' WHERE name LIKE '%__state__expired'`
      ]
    },
    {
      release: '1.1.0',
      version: 4,
      previous: 3,
      install: [
        `ALTER TABLE ${schema}.job ADD COLUMN priority integer not null default(0)`,
        `ALTER TABLE ${schema}.job ALTER COLUMN createdOn SET DATA TYPE timestamptz`,
        `ALTER TABLE ${schema}.job ALTER COLUMN startedOn SET DATA TYPE timestamptz`,
        `ALTER TABLE ${schema}.job ALTER COLUMN completedOn SET DATA TYPE timestamptz`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job DROP COLUMN priority`,
        `ALTER TABLE ${schema}.job ALTER COLUMN createdOn SET DATA TYPE timestamp`,
        `ALTER TABLE ${schema}.job ALTER COLUMN startedOn SET DATA TYPE timestamp`,
        `ALTER TABLE ${schema}.job ALTER COLUMN completedOn SET DATA TYPE timestamp`
      ]
    }
  ]
}
