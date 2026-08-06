import Db from '../src/db.ts'
import { BunBoss, fromPglite, fromBunSqlite } from '../src/index.ts'
import { PGlite } from '@electric-sql/pglite'
import { SQL } from 'bun'
import { describe, it, type SuiteAPI, type TestAPI } from './harness.ts'
import crypto from 'node:crypto'
import configJson from './config.json' with { type: 'json' }
import type { ConstructorOptions, IDatabase, FetchOptions, Job } from '../src/types.ts'
import { delay } from '../src/tools.ts'
import { getColumns, getConstraints, getIndexes, getFunctions } from './pgSchemaHelper.ts'
import { SQLITE as SQLITE_DIALECT } from '../src/dialect.ts'

const sha1 = (value: string): string => crypto.createHash('sha1').update(value).digest('hex')

// PGlite is embedded single-connection WASM PostgreSQL. The whole suite runs against it in-process
// via DB_TYPE=pglite: the process shares one in-memory instance, and every testHelper db
// operation (getDb, dropSchema, schema introspection) routes through it. There is no server, so
// connection-string / subprocess / multi-connection tests are skipped (see itPglite/describePglite).
const isPglite = process.env.DB_TYPE === 'pglite'

// One shared in-memory PGlite instance per process (bun test runs the whole suite in one process;
// per-test isolation comes from the schema). Construction is synchronous; readiness is awaited on
// first query.
let pgliteInstance: PGlite | undefined
function getPgliteInstance (): PGlite {
  pgliteInstance ??= new PGlite()
  return pgliteInstance
}

// A getDb()-compatible wrapper over the shared PGlite instance. close() is a no-op so callers that
// open/close per operation don't tear down the instance shared by the rest of the file.
function getPgliteDb (): IDatabase & { close: () => Promise<void> } {
  const db = fromPglite(getPgliteInstance())
  return { executeSql: db.executeSql, close: async () => {} }
}

// SQLite runs in-process through Bun's built-in SQL client (sqlite://:memory:) with the `sqlite`
// backend profile — a different SQL dialect, not a Postgres-compatible engine. The process shares
// one in-memory database; per-test isolation comes from the quoted-name prefix
// ("<schema>.job"), so dropSchema drops the prefixed tables. No server, so connection-string /
// subprocess / multi-connection tests are skipped like PGlite's.
const isSqlite = process.env.DB_TYPE === 'sqlite'

// One shared in-memory SQLite database per process, mirroring the PGlite instance below.
let sqliteInstance: SQL | undefined
function getSqliteInstance (): SQL {
  sqliteInstance ??= new SQL('sqlite://:memory:')
  return sqliteInstance
}

// A getDb()-compatible wrapper over the shared SQLite database; close() is a no-op for the same
// reason as getPgliteDb().
function getSqliteDb (): IDatabase & { close: () => Promise<void> } {
  const db = fromBunSqlite(getSqliteInstance())
  return { executeSql: db.executeSql, close: async () => {} }
}

// The no-SKIP-LOCKED / no-multi-mutation-CTE runtime path (the atomic-UPDATE fetch + split-statement
// writes the SQLite backend uses). It is a pure runtime toggle (no schema impact) and works fine on
// plain PostgreSQL, so we exercise the whole suite under it on Postgres via NO_SKIP_LOCKED_NO_CTE=true
// — fast, reliable coverage of those branches without SQLite's dialect.
const isNoSkipLockedNoCte = process.env.NO_SKIP_LOCKED_NO_CTE === 'true'

// Wrap tests that depend on Postgres-only features (table partitioning, covering indexes, exact PG
// schema shape) with these so they are skipped automatically under SQLite.
// The `it` here is the harness wrapper (per-test schema setup lives in its body), so every skip
// helper below must be built from it — bun's raw `it` would silently bypass that setup.
const itPostgresOnly = it.skipIf(isSqlite) as TestAPI
const describePostgresOnly = describe.skipIf(isSqlite) as SuiteAPI

// PGlite has no server, so tests that connect by connection string (subprocess, ORM adapters)
// or that require multiple independent connections cannot run against it. Wrap them with these.
// SQLite shares every one of those limitations, so it rides the same gates.
const itPglite = it.skipIf(isPglite || isSqlite) as TestAPI
const describePglite = describe.skipIf(isPglite || isSqlite) as SuiteAPI

// Tests whose assertion SQL or behavior is irreducibly Postgres (raw pg constructs the qualify()
// helper can't bridge, deep jsonb containment, pg_catalog probes). Wrap them with these.
const itSqlite = it.skipIf(isSqlite) as TestAPI
const describeSqlite = describe.skipIf(isSqlite) as SuiteAPI

// Tests that need multiple independent role connections (e.g. one session holds a lock while
// another polls) can't run on PGlite (single in-process instance, no network).
const describeMultiConnectionOnly = describe.skipIf(isPglite || isSqlite) as SuiteAPI

// LISTEN/NOTIFY behavior tests need a db adapter that implements `listen`, and in this suite that
// is only PGlite's in-process listener (fromPglite): Bun's SQL client implements neither LISTEN
// nor NOTIFY delivery, and SQLite has no LISTEN/NOTIFY at all. Wrap notify-behavior tests with
// these so they run only under DB_TYPE=pglite; the producer bypass is still covered separately on
// every backend.
const itListenNotify = it.skipIf(!isPglite) as TestAPI
const describeListenNotify = describe.skipIf(!isPglite) as SuiteAPI

function assertTruthy<T> (value: T, message?: string): asserts value is NonNullable<T> {
  if (value == null) {
    throw new Error(message ?? 'Expected value to be defined')
  }
}

// The connection settings for the active DB_TYPE, before any bun-boss options are layered on.
function getConnectionConfig (): any {
  const config: any = { ...configJson }

  if (isPglite || isSqlite) {
    config.host = undefined
    config.port = undefined
  } else {
    config.host = process.env.POSTGRES_HOST || config.host
    config.port = process.env.POSTGRES_PORT || config.port
    config.password = process.env.POSTGRES_PASSWORD || config.password
  }

  return config
}

function getConnectionString (): string {
  // PGlite has no server/connection string. Return an unusable placeholder rather than throwing so
  // that test files referencing it during collection still load; the tests themselves are skipped
  // under PGlite via itPglite/describePglite.
  if (isPglite) return 'pglite://unsupported'

  // Deliberately NOT a bun-autodetectable sqlite:// URL, so an accidentally-unskipped test can't
  // create a stray database file.
  if (isSqlite) return 'sqlite-unsupported://unsupported'

  const config = getConnectionConfig()

  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`
}

function getConfig (options: Partial<ConstructorOptions> & { testKey?: string } = {}): ConstructorOptions {
  const config: any = getConnectionConfig()

  if (options.testKey) {
    config.schema = `pgboss${sha1(options.testKey)}`
  }

  config.schema = config.schema || 'pgboss'

  config.supervise = false
  config.schedule = false
  config.createSchema = true

  // Select the backend profile, which attorney expands into the right compatibility flags.
  config.backend = isPglite ? 'pglite' : isSqlite ? 'sqlite' : 'postgres'

  // On plain Postgres we exercise the no-SKIP-LOCKED / no-CTE code paths via NO_SKIP_LOCKED_NO_CTE=true,
  // which forces them through the internal __test__noSkipLockedNoCte hook (not publicly configurable).
  if (isNoSkipLockedNoCte) {
    config.__test__noSkipLockedNoCte = true
  }

  // Route every boss built from this config at the shared in-process PGlite instance. A fresh
  // fromPglite wrapper per call is fine — it is a stateless adapter over the one instance.
  if (isPglite && !('db' in options)) {
    config.db = fromPglite(getPgliteInstance())
  }

  // And for sqlite: a stateless adapter over the shared in-memory database (the adapter's
  // serialization lock is keyed on the SQL instance, so fresh wrappers per call are safe).
  if (isSqlite && !('db' in options)) {
    config.db = fromBunSqlite(getSqliteInstance())
  }

  return Object.assign(config, options)
}

// The docker compose command that starts the Postgres test database.
function dockerStartHint (): string {
  return 'docker compose up -d db'
}

// Preflight the database connection so a missing/unstarted container fails with an actionable hint
// (which docker compose command to run) instead of a bare ECONNREFUSED buried in every test. The
// pool is lazy, so we issue a real query to force the connection. Connect to the always-present
// `postgres` admin database since the pgboss database may not exist yet.
async function assertDbReachable (): Promise<void> {
  let db: Db | undefined
  try {
    db = await getDb({ database: 'postgres' })
    await db.executeSql('SELECT 1')
  } catch (err: any) {
    const target = `${process.env.DB_TYPE || 'postgres'} test database`
    throw new Error(
      `\nCannot reach the ${target} (${err?.message || err}).\n` +
      `Start its container with:\n\n    ${dockerStartHint()}\n`
    )
  } finally {
    await db?.close()
  }
}

async function init (): Promise<void> {
  // PGlite and SQLite are in-memory and have no concept of CREATE DATABASE; nothing to provision.
  if (isPglite || isSqlite) return

  const { database } = getConfig()

  assertTruthy(database)
  await assertDbReachable()
  await tryCreateDb(database)
}

async function getDb ({ database, debug }: { database?: string; debug?: boolean } = {}): Promise<Db> {
  if (isPglite) return getPgliteDb() as unknown as Db
  if (isSqlite) return getSqliteDb() as unknown as Db

  const config = getConfig()

  config.database = database || config.database

  const db = new Db({ ...config, debug })

  await db.open()

  return db
}

// Renders a schema-qualified table reference for raw test SQL: real schema qualification on
// Postgres-likes, the sqlite dialect's quoted-name prefix ("schema.table") on SQLite.
function qualify (schema: string, table: string): string {
  return isSqlite ? `"${schema}.${table}"` : `${schema}.${table}`
}

// A PlanContext for tests calling plans.* builders directly, so the rendered SQL matches the
// active backend's dialect.
function planCtx (schema: string): { schema: string, dialect?: typeof SQLITE_DIALECT } {
  return { schema, dialect: isSqlite ? SQLITE_DIALECT : undefined }
}

async function dropSchema (schema: string): Promise<void> {
  const db = await getDb()

  if (isSqlite) {
    // No schemas in SQLite: the namespace is the quoted-name prefix, so drop every prefixed table
    // (indexes go with them). FK enforcement is suspended for the drops — job/schedule reference
    // queue, and there is no CASCADE ordering. LIKE has no wildcard risk — schema names are hex.
    const { rows } = await db.executeSql(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '${schema}.%'`)
    if (rows.length) {
      const drops = rows.map((row: any) => `DROP TABLE IF EXISTS "${row.name}"`).join(';\n')
      await db.executeSql(`PRAGMA foreign_keys = OFF;\n${drops};\nPRAGMA foreign_keys = ON`)
    }
  } else {
    await db.executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  }

  await db.close()
}

async function findJobs (schema: string, where: string, values?: any[]): Promise<any> {
  const db = await getDb()
  const jobs = await db.executeSql(`select * from ${qualify(schema, 'job')} where ${where}`, values)
  await db.close()
  return jobs
}

async function countJobs (schema: string, table: string, where: string, values?: any[]): Promise<number> {
  const db = await getDb()
  const result = await db.executeSql(`select count(*) as count from ${qualify(schema, table)} where ${where}`, values)
  await db.close()
  return parseFloat(result.rows[0].count)
}

async function tryCreateDb (database: string): Promise<void> {
  const db = await getDb({ database: 'postgres' })

  try {
    await db.executeSql(`CREATE DATABASE ${database}`)
  } catch {} finally {
    await db.close()
  }
}

// PGlite often assigns the same created_on to back-to-back inserts. Tests that assert FIFO /
// insertion order (ORDER BY created_on, id) need distinct timestamps; without them UUID id order
// can win and look like a policy bug. No-op on real Postgres, where statement boundaries already
// advance now(). start() wires this into every job-creating method below, so suites rarely need to
// call it directly - reach for it only when writing jobs through the db handle instead of boss.
async function separateTimestamps (): Promise<void> {
  // SQLite shares the failure mode: millisecond resolution means back-to-back writes can land on
  // the same created_on, letting random UUID order win FIFO assertions.
  if (isPglite || isSqlite) await delay(2)
}

// Job-creating methods wrapped by start() under PGlite so each write lands on its own created_on.
const JOB_WRITE_METHODS = ['send', 'sendAfter', 'sendThrottled', 'sendDebounced', 'insert'] as const

async function start (options?: Partial<ConstructorOptions> & { testKey?: string; noDefault?: boolean }): Promise<BunBoss> {
  try {
    const config = getConfig(options)

    const boss = new BunBoss(config)
    // boss.on('error', err => console.log({ schema: config.schema, message: err.message }))

    await boss.start()

    if (!options?.noDefault) {
      assertTruthy(config.schema)
      await boss.createQueue(config.schema)
    }

    // Advance the clock after each write so insertion ordering matches real Postgres without
    // sprinkling delays through every suite. See separateTimestamps.
    if (isPglite || isSqlite) {
      for (const method of JOB_WRITE_METHODS) {
        const original = boss[method].bind(boss) as (...args: unknown[]) => Promise<unknown>
        // @ts-ignore - one wrapper shape for a set of overloaded signatures
        boss[method] = async (...args: unknown[]) => {
          const result = await original(...args)
          await separateTimestamps()
          return result
        }
      }
    }

    return boss
  } catch (err) {
    // this is nice for occaisional debugging, Mr. Linter
    if (err) {
      throw err
    }
    throw new Error('Unexpected error')
  }
}

// PGlite's now() has coarse, sub-statement resolution, so consecutive statements often share a
// timestamp. Fetch uses `start_after <= now()` so a row inserted with the default start_after =
// now() is immediately claimable; prefer that over relying on the clock to tick between send and
// fetch. fetchWithRetry remains useful for cases where work appears asynchronously (e.g. a job
// just routed to a dead letter queue) and may not be visible on the first attempt.
async function fetchWithRetry<T = object> (boss: BunBoss, name: string, options?: FetchOptions, attempts = 20): Promise<Job<T>[]> {
  for (let i = 0; i < attempts; i++) {
    const jobs = await boss.fetch<T>(name, options)
    if (jobs.length > 0) {
      return jobs
    }
    await delay(2)
  }
  return []
}

async function getSchemaDefs (schemas: string[]) {
  const columnsSql = getColumns(schemas)
  const indexeSql = getIndexes(schemas)
  const constraintsSql = getConstraints(schemas)
  const functionsSql = getFunctions(schemas)

  const db = await getDb()

  const [columns, indexes, constraints, functions] = await Promise.all([
    db.executeSql(columnsSql),
    db.executeSql(indexeSql),
    db.executeSql(constraintsSql),
    db.executeSql(functionsSql)
  ])

  await db.close()

  return { columns, indexes, constraints, functions }
}

export {
  assertTruthy,
  dropSchema,
  getPgliteInstance,
  start,
  fetchWithRetry,
  separateTimestamps,
  getDb,
  countJobs,
  findJobs,
  getConfig,
  getConnectionString,
  tryCreateDb,
  init,
  isPglite,
  isSqlite,
  isNoSkipLockedNoCte,
  itPostgresOnly,
  describePostgresOnly,
  itPglite,
  describePglite,
  itSqlite,
  describeSqlite,
  describeMultiConnectionOnly,
  itListenNotify,
  describeListenNotify,
  getSchemaDefs,
  qualify,
  planCtx
}
