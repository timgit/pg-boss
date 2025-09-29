import assert from 'node:assert'
import { assertMigration, locked, setVersion } from './plans.js'

function flatten (schema, commands, version) {
  commands.unshift(assertMigration(schema, version))
  commands.push(setVersion(schema, version))

  return locked(schema, commands)
}

export function rollback (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations.find((i) => i.version === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.uninstall || [], result.previous)
}

export function next (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations.find((i) => i.previous === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

export function migrate (value, version, migrations) {
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
    .filter((i) => i.previous >= version)
    .sort((a, b) => a.version - b.version)
    .reduce(
      (acc, i) => {
        acc.install = acc.install.concat(i.install)
        acc.version = i.version
        return acc
      },
      { install: [], version }
    )

  assert(result.install.length > 0, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

export function getAll (_schema) {
  return []
}
