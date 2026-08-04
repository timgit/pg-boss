import Db from '../src/db.ts'
import { PgBoss, fromPglite } from '../src/index.ts'
import { PGlite } from '@electric-sql/pglite'
import { describe, it, type SuiteAPI, type TestAPI } from 'vitest'
import crypto from 'node:crypto'
import configJson from './config.json' with { type: 'json' }
import cockroachConfigJson from './config.cockroachdb.json' with { type: 'json' }
import yugabyteConfigJson from './config.yugabytedb.json' with { type: 'json' }
import citusConfigJson from './config.citus.json' with { type: 'json' }
import type { ConstructorOptions, IDatabase, FetchOptions, Job } from '../src/types.ts'
import { delay } from '../src/tools.ts'
import { getColumns, getConstraints, getIndexes, getFunctions } from './pgSchemaHelper.ts'

const sha1 = (value: string): string => crypto.createHash('sha1').update(value).digest('hex')

const isCockroachDb = process.env.DB_TYPE === 'cockroachdb'

// YugabyteDB is PostgreSQL-compatible and supports partitioning, deferrable constraints, and
// covering indexes, so it runs the standard fetch path. It only needs noAdvisoryLocks, which makes
// it a good independent check that the advisory-lock-free path works on its own.
const isYugabyteDb = process.env.DB_TYPE === 'yugabytedb'

// Citus is the Citus extension on a single-node coordinator. pg-boss does not call
// create_distributed_table(), so its tables stay local to the coordinator and behave like plain
// PostgreSQL - no special flags needed. This checks the schema/queries work with Citus loaded.
const isCitus = process.env.DB_TYPE === 'citus'

// PGlite is embedded single-connection WASM PostgreSQL. The whole suite runs against it in-process
// via DB_TYPE=pglite: each test-file worker shares one in-memory instance, and every testHelper db
// operation (getDb, dropSchema, schema introspection) routes through it. There is no server, so
// connection-string / subprocess / multi-connection tests are skipped (see itPglite/describePglite).
const isPglite = process.env.DB_TYPE === 'pglite'

// One shared in-memory PGlite instance per worker (vitest runs each test file in its own fork, so
// this is created once per file). Construction is synchronous; readiness is awaited on first query.
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

// Distributed database mode is the atomic-UPDATE fetch strategy used by CockroachDB et al. It is a
// pure runtime toggle (no schema impact) and works fine on plain PostgreSQL, so we exercise the
// whole suite under it on Postgres via DISTRIBUTED=true — fast, reliable coverage of the distributed
// code paths without paying CockroachDB's slow per-test DDL. CockroachDB always implies it.
const isDistributed = isCockroachDb || process.env.DISTRIBUTED === 'true'

// The full suite runs against CockroachDB via `npm run test:cockroachdb`, where getConfig()
// auto-enables noSkipLocked + noMultiMutationCte + the compatibility flags. Wrap tests that depend on
// Postgres-only features (table partitioning, covering indexes, exact PG schema shape) with these
// so they are skipped automatically under CockroachDB.
// Annotated with the exported TestAPI/SuiteAPI types: skipIf() returns vitest's internal
// ChainableTestAPI/ChainableSuiteAPI, which can't be named in this module's emitted
// declarations (TS4023). The exported aliases are nameable and callable the same way.
const itPostgresOnly = it.skipIf(isCockroachDb) as TestAPI
const describePostgresOnly = describe.skipIf(isCockroachDb) as SuiteAPI

// PGlite has no server, so tests that connect by connection string (CLI subprocess, ORM adapters)
// or that require multiple independent connections cannot run against it. Wrap them with these.
const itPglite = it.skipIf(isPglite) as TestAPI
const describePglite = describe.skipIf(isPglite) as SuiteAPI

// Tests that need multiple independent role connections (e.g. one session holds a lock while
// another polls) can't run on PGlite (single in-process instance, no network) or CockroachDB.
const describeMultiConnectionOnly = describe.skipIf(isPglite || isCockroachDb) as SuiteAPI

// LISTEN/NOTIFY is unavailable in these backends' test environments: CockroachDB never implements
// it (noListenNotify), and the YugabyteDB test container doesn't enable the early-access
// `ysql_yb_enable_listen_notify` flag. Wrap notify-behavior tests with these so the compatibility
// matrix skips them; the producer bypass is still covered separately on every backend.
const itListenNotify = it.skipIf(isCockroachDb || isYugabyteDb) as TestAPI
const describeListenNotify = describe.skipIf(isCockroachDb || isYugabyteDb) as SuiteAPI

function assertTruthy<T> (value: T, message?: string): asserts value is NonNullable<T> {
  if (value == null) {
    throw new Error(message ?? 'Expected value to be defined')
  }
}

function getConnectionString (): string {
  // PGlite has no server/connection string. Return an unusable placeholder rather than throwing so
  // that test files referencing it during collection still load; the tests themselves are skipped
  // under PGlite via itPglite/describePglite.
  if (isPglite) return 'pglite://unsupported'

  const config = getConfig()

  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`
}

function getConfig (options: Partial<ConstructorOptions> & { testKey?: string } = {}): ConstructorOptions {
  const baseConfig = isCockroachDb ? cockroachConfigJson : isYugabyteDb ? yugabyteConfigJson : isCitus ? citusConfigJson : configJson
  const config: any = { ...baseConfig }

  if (isPglite) {
    config.host = undefined
    config.port = undefined
  } else if (isYugabyteDb) {
    config.host = process.env.YUGABYTE_HOST || config.host
    config.port = process.env.YUGABYTE_PORT || config.port
  } else if (isCitus) {
    config.host = process.env.CITUS_HOST || config.host
    config.port = process.env.CITUS_PORT || config.port
  } else {
    config.host = (isCockroachDb ? process.env.COCKROACH_HOST : process.env.POSTGRES_HOST) || config.host
    config.port = (isCockroachDb ? process.env.COCKROACH_PORT : process.env.POSTGRES_PORT) || config.port
    config.password = process.env.POSTGRES_PASSWORD || config.password
  }

  if (options.testKey) {
    config.schema = `pgboss${sha1(options.testKey)}`
  }

  config.schema = config.schema || 'pgboss'

  config.supervise = false
  config.schedule = false
  config.createSchema = true

  // Select the backend profile, which attorney expands into the right compatibility flags
  // (CockroachDB: distributed + all no* gates; YugabyteDB: noAdvisoryLocks + noTablePartitioning
  // per yugabyte-db#21833; Citus: plain Postgres). This keeps the flag matrix in one place.
  config.backend = isPglite ? 'pglite' : isCockroachDb ? 'cockroachdb' : isYugabyteDb ? 'yugabytedb' : isCitus ? 'citus' : 'postgres'

  // The distributed runtime toggles are orthogonal to schema flags: CockroachDB's profile already
  // enables them; on plain Postgres we exercise the same code paths via DISTRIBUTED=true, which
  // forces them through the internal __test__distributed hook (they are not publicly configurable).
  if (isDistributed) {
    config.__test__distributed = true
  }

  // Route every boss built from this config at the shared in-process PGlite instance. A fresh
  // fromPglite wrapper per call is fine — it is a stateless adapter over the one instance.
  if (isPglite && !('db' in options)) {
    config.db = fromPglite(getPgliteInstance())
  }

  return Object.assign(config, options)
}

// Maps the active DB_TYPE to the docker compose command that starts its container(s). The default
// Postgres lives in docker-compose.yaml; each alternative backend has its own compose file/project
// so it never starts alongside the default. CockroachDB is a three-node cluster (plus init/setup
// jobs that create the database) — starting a single node leaves it uninitialized — so it uses `--wait`.
function dockerStartHint (): string {
  if (isCockroachDb) return 'docker compose -f docker-compose.cockroach.yaml up -d --wait'
  if (isYugabyteDb) return 'docker compose -f docker-compose.yugabyte.yaml up -d'
  if (isCitus) return 'docker compose -f docker-compose.citus.yaml up -d'
  return 'docker compose up -d db'
}

// Preflight the database connection so a missing/unstarted container fails with an actionable hint
// (which docker compose command to run) instead of a bare ECONNREFUSED buried in every test. The
// pg pool is lazy, so we issue a real query to force the connection. Connect to the always-present
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
  // PGlite is in-memory and has no concept of CREATE DATABASE; nothing to provision.
  if (isPglite) return

  const { database } = getConfig()

  assertTruthy(database)
  await assertDbReachable()
  await tryCreateDb(database)
}

async function getDb ({ database, debug }: { database?: string; debug?: boolean } = {}): Promise<Db> {
  if (isPglite) return getPgliteDb() as unknown as Db

  const config = getConfig()

  config.database = database || config.database

  const db = new Db({ ...config, debug })

  await db.open()

  return db
}

async function dropSchema (schema: string): Promise<void> {
  const db = await getDb()
  await db.executeSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await db.close()
}

async function findJobs (schema: string, where: string, values?: any[]): Promise<any> {
  const db = await getDb()
  const jobs = await db.executeSql(`select * from ${schema}.job where ${where}`, values)
  await db.close()
  return jobs
}

async function countJobs (schema: string, table: string, where: string, values?: any[]): Promise<number> {
  const db = await getDb()
  const result = await db.executeSql(`select count(*) as count from ${schema}.${table} where ${where}`, values)
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
  if (isPglite) await delay(2)
}

// Job-creating methods wrapped by start() under PGlite so each write lands on its own created_on.
const JOB_WRITE_METHODS = ['send', 'sendAfter', 'sendThrottled', 'sendDebounced', 'insert'] as const

async function start (options?: Partial<ConstructorOptions> & { testKey?: string; noDefault?: boolean }): Promise<PgBoss> {
  try {
    const config = getConfig(options)

    const boss = new PgBoss(config)
    // boss.on('error', err => console.log({ schema: config.schema, message: err.message }))

    await boss.start()

    if (!options?.noDefault) {
      assertTruthy(config.schema)
      await boss.createQueue(config.schema)
    }

    // Advance the clock after each write so insertion ordering matches real Postgres without
    // sprinkling delays through every suite. See separateTimestamps.
    if (isPglite) {
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
async function fetchWithRetry<T = object> (boss: PgBoss, name: string, options?: FetchOptions, attempts = 20): Promise<Job<T>[]> {
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
  isCockroachDb,
  isYugabyteDb,
  isCitus,
  isPglite,
  isDistributed,
  itPostgresOnly,
  describePostgresOnly,
  itPglite,
  describePglite,
  describeMultiConnectionOnly,
  itListenNotify,
  describeListenNotify,
  getSchemaDefs
}
