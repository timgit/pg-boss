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
    plans.advisoryLock()
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

function migrate (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations
    .filter(i => i.previous >= version)
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
      version: 11,
      previous: 10,
      install: [
          `CREATE INDEX archive_archivedon_idx ON ${schema}.archive(archivedon)`
      ],
      uninstall: [
          `DROP INDEX ${schema}.archive_archivedon_idx`
      ]
    }
  ]
}
