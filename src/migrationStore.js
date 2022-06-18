const assert = require('assert')
const plans = require('./plans')

module.exports = {
  rollback,
  next,
  migrate,
  getAll
}

function flatten (schema, commands, version) {
  commands.unshift(plans.assertMigration(schema, version))
  commands.push(plans.setVersion(schema, version))

  return plans.locked(schema, commands)
}

function rollback (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.version === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.uninstall || [], result.previous)
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

function getAll (schema) {
  return [
    {
      release: '7.4.0',
      version: 20,
      previous: 19,
      install: [
        `DROP INDEX ${schema}.job_singletonKey`,
        `DROP INDEX ${schema}.job_singleton_queue`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL AND NOT singletonKey LIKE '\\_\\_pgboss\\_\\_singleton\\_queue%'`,
        `CREATE UNIQUE INDEX job_singleton_queue ON ${schema}.job (name, singletonKey) WHERE state < 'active' AND singletonOn IS NULL AND singletonKey LIKE '\\_\\_pgboss\\_\\_singleton\\_queue%'`
      ],
      uninstall: [
        `DROP INDEX ${schema}.job_singletonKey`,
        `DROP INDEX ${schema}.job_singleton_queue`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL AND NOT singletonKey = '__pgboss__singleton_queue'`,
        `CREATE UNIQUE INDEX job_singleton_queue ON ${schema}.job (name, singletonKey) WHERE state < 'active' AND singletonOn IS NULL AND singletonKey = '__pgboss__singleton_queue'`
      ]
    },
    {
      release: '7.0.0',
      version: 19,
      previous: 18,
      install: [
        `CREATE TABLE ${schema}.subscription (
          event text not null,
          name text not null,
          created_on timestamp with time zone not null default now(),
          updated_on timestamp with time zone not null default now(),
          PRIMARY KEY(event, name)
        )`
      ],
      uninstall: [
        `DROP TABLE ${schema}.subscription`
      ]
    },
    {
      release: '6.1.1',
      version: 18,
      previous: 17,
      install: [
        `ALTER TABLE ${schema}.job ALTER COLUMN on_complete SET DEFAULT false`
      ]
    },
    {
      release: '6.0.0',
      version: 17,
      previous: 16,
      install: [
        `DROP INDEX ${schema}.job_singletonKey`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL AND NOT singletonKey = '__pgboss__singleton_queue'`,
        `CREATE UNIQUE INDEX job_singleton_queue ON ${schema}.job (name, singletonKey) WHERE state < 'active' AND singletonOn IS NULL AND singletonKey = '__pgboss__singleton_queue'`,
        `CREATE INDEX IF NOT EXISTS job_fetch ON ${schema}.job (name text_pattern_ops, startAfter) WHERE state < 'active'`,
        `ALTER TABLE ${schema}.job ADD output jsonb`,
        `ALTER TABLE ${schema}.archive ADD output jsonb`,
        `ALTER TABLE ${schema}.job ALTER COLUMN on_complete SET DEFAULT false`,
        `ALTER TABLE ${schema}.job ALTER COLUMN keepuntil SET DEFAULT now() + interval '14 days'`
      ],
      uninstall: [
        `DROP INDEX ${schema}.job_fetch`,
        `DROP INDEX ${schema}.job_singleton_queue`,
        `DROP INDEX ${schema}.job_singletonKey`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL`,
        `ALTER TABLE ${schema}.job DROP COLUMN output`,
        `ALTER TABLE ${schema}.archive DROP COLUMN output`,
        `ALTER TABLE ${schema}.job ALTER COLUMN on_complete SET DEFAULT true`,
        `ALTER TABLE ${schema}.job ALTER COLUMN keepuntil SET DEFAULT now() + interval '30 days'`
      ]
    },
    {
      release: '5.2.0',
      version: 16,
      previous: 15,
      install: [
          `ALTER TABLE ${schema}.job ADD on_complete boolean`,
          `UPDATE ${schema}.job SET on_complete = true`,
          `ALTER TABLE ${schema}.job ALTER COLUMN on_complete SET DEFAULT true`,
          `ALTER TABLE ${schema}.job ALTER COLUMN on_complete SET NOT NULL`,
          `ALTER TABLE ${schema}.archive ADD on_complete boolean`
      ],
      uninstall: [
          `ALTER TABLE ${schema}.job DROP COLUMN on_complete`,
          `ALTER TABLE ${schema}.archive DROP COLUMN on_complete`
      ]
    },
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
    }
  ]
}
