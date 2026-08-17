import assert from 'node:assert'
import * as plans from './plans.ts'
import packageJson from '../package.json' with { type: 'json' }
import type * as types from './types.ts'

const schemaVersion = packageJson.bunboss.schema as number

// A name postgres would store unchanged if written without quotes.
const BARE_LOWER_IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]*$/

class Contractor {
  static constructionPlans (schema?: string, options?: { tableIsolation?: 'schema' | 'prefix' }) {
    const prefix = options?.tableIsolation === 'prefix'
    const name = schema ?? (prefix ? plans.DEFAULT_PREFIX : plans.DEFAULT_SCHEMA)
    // Schema mode passes a bare string (byte-identical to the pre-isolation static caller); prefix
    // mode carries the isolation on a context object and skips schema creation and partitioning.
    return prefix
      ? plans.create({ schema: name, tableIsolation: 'prefix' }, schemaVersion, { createSchema: false, noTablePartitioning: true })
      : plans.create(name, schemaVersion, { createSchema: true })
  }

  private config: types.ResolvedConstructorOptions
  private db: types.IDatabase

  constructor (db: types.IDatabase, config: types.ResolvedConstructorOptions) {
    this.config = config
    this.db = db
  }

  async schemaVersion () {
    const result = await this.db.executeSql(plans.getVersion(this.config))
    return result.rows.length ? parseInt(result.rows[0].version) : null
  }

  async isInstalled () {
    const result = await this.db.executeSql(plans.versionTableExists(this.config))
    return !!result.rows[0].name
  }

  async start () {
    const installed = await this.isInstalled()

    if (installed) {
      const version = await this.schemaVersion()

      // bun-boss installs fresh at the current schema version and carries no migration history;
      // a lower installed version means this database predates this release and can't be upgraded.
      if (version !== null && schemaVersion > version) {
        throw new Error(`schema version ${version} cannot be upgraded to ${schemaVersion} by this release (no in-place migration path)`)
      }
    } else {
      await this.assertNoSchemaCaseVariant()
      await this.create()
    }
  }

  // `schema: 'MySchema'` and `schema: '"MySchema"'` are two different schemas - postgres folds the
  // bare form to `myschema` and stores the quoted one verbatim - but the two configs differ by two
  // characters and are indistinguishable in logs. Getting it wrong is not an error on its own: the
  // version table simply isn't there, so bun-boss installs a second, empty schema alongside the
  // populated one and every existing job silently disappears. Fires only on the install path, and
  // only when the variant actually holds a bun-boss install, so an unrelated schema that happens to
  // share a folded name never blocks a legitimate install.
  private async assertNoSchemaCaseVariant () {
    if (this.config.allowSchemaCaseVariant) {
      return
    }

    // Prefix mode has no dedicated schema, so the pg_namespace case-variant probe does not apply.
    if (this.config.tableIsolation === 'prefix') {
      return
    }

    const schema = this.config.schema
    let variants: string[]

    try {
      const result = await this.db.executeSql(plans.getSchemaCaseVariants(schema))
      variants = result.rows.map((r: { name: string }) => r.name)
    } catch {
      // Catalog access varies across backends and permission setups. A probe that cannot run is
      // not evidence of a problem, so it must never block an install that would otherwise succeed.
      return
    }

    if (variants.length === 0) {
      return
    }

    // A variant that is already a legal lower-case bare identifier is reached by writing it bare;
    // anything else (mixed case, or a name needing quotes) has to be configured quoted.
    const spellings = variants.map(name => BARE_LOWER_IDENTIFIER_REGEX.test(name) ? `'${name}'` : `'"${name}"'`)

    throw new Error(`bun-boss is not installed in schema ${schema}, but is installed in ${variants.map(n => `"${n}"`).join(', ')}, which differs only in case. ` +
      'PostgreSQL folds unquoted names to lower case and stores quoted names verbatim, so these are different schemas. ' +
      `To use the existing installation, set schema: ${spellings.join(' or ')}. ` +
      'To install a new schema beside it anyway, set allowSchemaCaseVariant: true.')
  }

  async check () {
    const installed = await this.isInstalled()

    if (!installed) {
      throw new Error('bun-boss is not installed')
    }

    const version = await this.schemaVersion()

    if (schemaVersion !== version) {
      throw new Error(`bun-boss schema version ${version} does not match the expected version ${schemaVersion}`)
    }
  }

  async create () {
    try {
      const commands = plans.create(this.config, schemaVersion, this.config)
      await this.db.executeSql(commands)
    } catch (err: any) {
      // A tight CREATE SCHEMA IF NOT EXISTS race surfaces as a duplicate pg_namespace key whose
      // message lacks 'already exists' (only the detail carries it), so match that flavor too.
      const benignRace = err.message.includes(plans.CREATE_RACE_MESSAGE) ||
        (err.code === '23505' && err.constraint === 'pg_namespace_nspname_index')
      assert(benignRace, err)
    }
  }
}

export default Contractor
