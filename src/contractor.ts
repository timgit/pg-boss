import assert from 'node:assert'
import * as plans from './plans.ts'
import * as drifter from './drifter.ts'
import * as migrationStore from './migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }
import type * as types from './types.ts'

const schemaVersion = packageJson.pgboss.schema as number

// A name postgres would store unchanged if written without quotes.
const BARE_LOWER_IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]*$/

class Contractor {
  static constructionPlans (schema = plans.DEFAULT_SCHEMA, options = { createSchema: true }) {
    return plans.create(schema, schemaVersion, options)
  }

  static migrationPlans (schema = plans.DEFAULT_SCHEMA, version = schemaVersion - 1, options: { partitionTables?: Array<string | types.MigrationPartition> } = {}) {
    // Exported plans run without a BAM worker, so inline the async index builds as direct
    // DDL rather than job_table_run_async() enqueues (see issue #766). Callers that hold a
    // live connection can pass partition metadata to fan the builds out across partitions.
    return migrationStore.migrate(schema, version, undefined, undefined, { inlineAsync: true, partitionTables: options.partitionTables })
  }

  static rollbackPlans (schema = plans.DEFAULT_SCHEMA, version = schemaVersion) {
    return migrationStore.rollback(schema, version)
  }

  private config: types.ResolvedConstructorOptions
  private db: types.IDatabase
  private migrations: types.Migration[]

  constructor (db: types.IDatabase, config: types.ResolvedConstructorOptions) {
    this.config = config
    this.db = db
    this.migrations = this.config.migrations || migrationStore.getAll(this.config.schema, this.config.noTablePartitioning, this.config.noCoveringIndexes)
  }

  async schemaVersion () {
    const result = await this.db.executeSql(plans.getVersion(this.config.schema))
    return result.rows.length ? parseInt(result.rows[0].version) : null
  }

  async isInstalled () {
    const result = await this.db.executeSql(plans.versionTableExists(this.config.schema))
    return !!result.rows[0].name
  }

  async start () {
    const installed = await this.isInstalled()

    if (installed) {
      const version = await this.schemaVersion()

      if (version !== null && schemaVersion > version) {
        await this.migrate(version)
      }
    } else {
      await this.assertNoSchemaCaseVariant()
      await this.create()
    }
  }

  // `schema: 'MySchema'` and `schema: '"MySchema"'` are two different schemas - postgres folds the
  // bare form to `myschema` and stores the quoted one verbatim - but the two configs differ by two
  // characters and are indistinguishable in logs. Getting it wrong is not an error on its own: the
  // version table simply isn't there, so pg-boss installs a second, empty schema alongside the
  // populated one and every existing job silently disappears. Fires only on the install path, and
  // only when the variant actually holds a pg-boss install, so an unrelated schema that happens to
  // share a folded name never blocks a legitimate install.
  private async assertNoSchemaCaseVariant () {
    if (this.config.allowSchemaCaseVariant) {
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

    throw new Error(`pg-boss is not installed in schema ${schema}, but is installed in ${variants.map(n => `"${n}"`).join(', ')}, which differs only in case. ` +
      'PostgreSQL folds unquoted names to lower case and stores quoted names verbatim, so these are different schemas. ' +
      `To use the existing installation, set schema: ${spellings.join(' or ')}. ` +
      'To install a new schema beside it anyway, set allowSchemaCaseVariant: true.')
  }

  // Presence-level schema drift scan: compares the managed indexes the code expects against the live
  // catalog. Partitioned vs. non-partitioned is read from the database (job_common presence), and the
  // per-queue policy indexes are computed from the queue table, so conditional indexes are handled.
  async detectDrift (): Promise<types.SchemaDriftReport> {
    const schema = this.config.schema

    const probe = await this.db.executeSql(plans.jobCommonExists(schema))
    const partitioned = !!probe.rows[0].name

    const partitions = partitioned
      ? (await this.db.executeSql(plans.getManagedQueuePartitions(schema))).rows
      : []

    const liveResult = await this.db.executeSql(drifter.getSchemaIndexes(schema))
    const live = liveResult.rows.map((r: { name: string, table: string, valid: boolean, def: string, constraintBacked: boolean }) => ({
      name: r.name,
      table: r.table,
      valid: r.valid,
      def: r.def,
      constraintBacked: r.constraintBacked
    }))

    // The bam table only exists from schema v27; ignore its absence on very old schemas.
    let bamCommands: string[] = []
    try {
      const bamResult = await this.db.executeSql(plans.getIncompleteBamCommands(schema))
      bamCommands = bamResult.rows.map((r: { command: string }) => r.command)
    } catch {
      bamCommands = []
    }

    // Function-body and enum drift are best-effort: pg_get_functiondef is unsupported on some backends
    // (CockroachDB), so a failure here SKIPS the function check rather than aborting the whole scan.
    // `functionsSupported` must be tracked separately from an empty result: an empty `liveFunctions`
    // means "query failed / unsupported", which is NOT the same as "no functions found" — feeding
    // `live: []` to the drift check would report every expected function as missing and flip `ok` to
    // false on every CockroachDB scan. So the check is gated (passed `undefined`) when the query throws.
    let liveFunctions: Array<{ name: string, def: string }> = []
    let functionsSupported = true
    try {
      const fnResult = await this.db.executeSql(drifter.getSchemaFunctions(schema))
      liveFunctions = fnResult.rows.map((r: { name: string, def: string }) => ({ name: r.name, def: r.def }))
    } catch {
      functionsSupported = false
    }

    let enumLabels: string[] = []
    try {
      const enumResult = await this.db.executeSql(drifter.getEnumDefinition(schema))
      enumLabels = enumResult.rows.map((r: { label: string }) => r.label)
    } catch {
      enumLabels = []
    }

    // Table presence is read from a catalog-only query independent of the column diff below. The column
    // query uses pg_get_expr (unsupported on some backends) and is best-effort; if it throws, the column
    // check is skipped — but table presence must NOT collapse to "everything missing", so it comes from
    // its own pg_class probe. pg_class is available everywhere, so this rarely throws; if it somehow
    // does, fall back to the columns-derived set rather than aborting the scan.
    let liveTables: string[] | null = null
    try {
      const tableResult = await this.db.executeSql(drifter.getSchemaTables(schema))
      liveTables = tableResult.rows.map((r: { table: string }) => r.table)
    } catch {
      liveTables = null
    }

    let liveColumns: Array<{ table: string, column: string, default?: string | null, type?: string, notNull?: boolean }> = []
    try {
      const colResult = await this.db.executeSql(drifter.getSchemaColumns(schema))
      liveColumns = colResult.rows.map((r: { table: string, column: string, default: string | null, type: string, notNull: boolean }) =>
        ({ table: r.table, column: r.column, default: r.default, type: r.type, notNull: r.notNull }))
    } catch {
      liveColumns = []
    }

    let liveConstraints: Array<{ table: string, def: string }> = []
    try {
      const conResult = await this.db.executeSql(drifter.getSchemaConstraints(schema))
      liveConstraints = conResult.rows.map((r: { table: string, def: string }) => ({ table: r.table, def: r.def }))
    } catch {
      liveConstraints = []
    }

    const building = new Set(bamCommands.map(plans.bamCommandIndexName).filter((n): n is string => n !== null))

    // CockroachDB renders column types (INT8 vs integer), default expressions, and constraint
    // definitions differently from standard Postgres, so the canonical-form checks would false-positive
    // there. Restrict type/default/constraint drift to Postgres-typed backends; the presence checks
    // (tables, indexes, column names, functions, enum) still run everywhere.
    const canonicalPg = this.config.backend !== 'cockroachdb'
    const expectedColumns = plans.expectedManagedColumns(schema, partitioned, partitions)
      .map(c => canonicalPg ? c : { table: c.table, columns: c.columns })

    return drifter.computeSchemaDrift({
      indexes: { expected: plans.expectedManagedIndexes(schema, partitioned, partitions), live, building },
      tables: { expected: plans.expectedManagedTables(schema, partitioned, partitions), live: liveTables ?? [...new Set(liveColumns.map(c => c.table))] },
      functions: functionsSupported ? { expected: plans.expectedManagedFunctions(schema, partitioned), live: liveFunctions } : undefined,
      columns: { expected: expectedColumns, live: liveColumns },
      constraints: canonicalPg ? { expected: plans.expectedManagedConstraints(schema, partitioned), live: liveConstraints } : undefined,
      enum: { name: 'job_state', expected: plans.EXPECTED_JOB_STATES, actual: enumLabels }
    })
  }

  async check () {
    const installed = await this.isInstalled()

    if (!installed) {
      throw new Error('pg-boss is not installed')
    }

    const version = await this.schemaVersion()

    if (schemaVersion !== version) {
      throw new Error('pg-boss database requires migrations')
    }
  }

  async create () {
    try {
      const commands = plans.create(this.config.schema, schemaVersion, this.config)
      await this.db.executeSql(commands)
    } catch (err: any) {
      assert(err.message.includes(plans.CREATE_RACE_MESSAGE), err)
    }
  }

  async migrate (version: number) {
    try {
      const commands = migrationStore.migrate(this.config.schema, version, this.migrations, this.config.noAdvisoryLocks)
      await this.db.executeSql(commands)
    } catch (err: any) {
      assert(err.message.includes(plans.MIGRATE_RACE_MESSAGE), err)
    }
  }

  async next (version: number) {
    const commands = migrationStore.next(this.config.schema, version, this.migrations, this.config.noAdvisoryLocks)
    await this.db.executeSql(commands)
  }

  async rollback (version: number) {
    const commands = migrationStore.rollback(this.config.schema, version, this.migrations, this.config.noAdvisoryLocks)
    await this.db.executeSql(commands)
  }
}

export default Contractor
