const assert = require('node:assert')
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
      release: '10.1.1',
      version: 23,
      previous: 22,
      install: [
        `ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job DROP CONSTRAINT job_pkey`
      ]
    },
    {
      release: '10.0.6',
      version: 22,
      previous: 21,
      install: [
        `ALTER TABLE ${schema}.job ALTER COLUMN retry_limit SET DEFAULT 2`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job ALTER COLUMN retry_limit SET DEFAULT 0`
      ]
    }
  ]
}
