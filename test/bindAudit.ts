// The bind audit: checks every parameterised statement the suite sends against the encoding rules of
// the drivers it does not run on (see bindAuditRules.ts), so a plan that would break under Bun.SQL or
// PGlite fails here on plain Postgres. Loaded as a vitest setup file.
//
// It wraps pg.Client.prototype.query, which pooled and transaction statements both go through, and
// records the JS kind of each bound value. The first time it sees a statement it asks Postgres, on a
// side connection, which type it infers for each parameter (PREPARE, then pg_prepared_statements):
// the same inference a driver that sends untyped parameters gets. afterAll fails the file with
// every finding.
//
// Postgres only: PREPARE's parameter_types is what the rules read, and the other backends either
// do not report it the same way or, like PGlite, never go through pg.Client.
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll } from 'vitest'
import { getConfig } from './testHelper.ts'
import { checkBinds, kindOf } from './bindAuditRules.ts'

interface Statement {
  text: string
  types?: string[]
  signatures: Set<string>
}

const enabled = !process.env.DB_TYPE || process.env.DB_TYPE === 'postgres'

const statements = new Map<string, Statement>()
const query = pg.Client.prototype.query as (...args: any[]) => any

let side: pg.Client | undefined
let sideReady: Promise<unknown> | undefined
let describing: Promise<unknown> = Promise.resolve()
// Set when the side connection cannot be made. The audit then checks nothing, so afterAll fails the
// file with this rather than passing it.
let sideError: Error | undefined

// The per-test schema and generated table suffixes differ between runs of the same statement.
const normalize = (text: string) => text.replace(/pgboss[0-9a-f]{40}/g, '{schema}').replace(/[0-9a-f]{16,}/g, '{hex}').replace(/\s+/g, ' ').trim()

async function describeParameters (text: string): Promise<string[] | undefined> {
  if (!sideReady) {
    const { host, port, user, password, database } = getConfig()
    side = new pg.Client({ host, port, user, password, database })
    // Never wait long on a lock a test's open transaction holds; the statement is described on a
    // later sighting instead.
    sideReady = side.connect().then(() => query.call(side, "SET lock_timeout = '300ms'"))
    // Read in run() below; marked handled here in case it fails before anything awaits it.
    sideReady.catch(() => {})
  }

  const run = async () => {
    try {
      await sideReady
    } catch (err: any) {
      sideError ??= err
      return undefined
    }

    const name = 'bind_audit_' + randomUUID().replace(/-/g, '')

    try {
      await query.call(side, `PREPARE ${name} AS ${text}`)
      const { rows } = await query.call(side, 'SELECT parameter_types::text[] AS types FROM pg_prepared_statements WHERE name = $1', [name])
      await query.call(side, `DEALLOCATE ${name}`)
      return rows[0].types as string[]
    } catch {
      // Multi-statement scripts, utility statements, and objects created in a transaction the side
      // connection cannot see.
      return undefined
    }
  }

  const described = describing.then(run)
  describing = described.catch(() => {})
  return await described
}

async function record (text: string, values: unknown[]) {
  const key = normalize(text)
  let statement = statements.get(key)

  if (!statement) {
    statement = { text, signatures: new Set() }
    statements.set(key, statement)
  }

  statement.signatures.add(values.map(kindOf).join(','))
  statement.types ??= await describeParameters(text)
}

if (enabled) {
  pg.Client.prototype.query = function (this: pg.Client, ...args: any[]) {
    const [config, maybeValues] = args

    // Submittables (cursors, pg-query-stream) carry their own lifecycle.
    if (config && typeof config.submit === 'function') return query.apply(this, args)

    const text: string | undefined = typeof config === 'string' ? config : config?.text
    const values: unknown[] | undefined = Array.isArray(maybeValues) ? maybeValues : config?.values

    if (!text || !values?.length) return query.apply(this, args)

    // Recorded once the statement settles and before its caller resumes, while the per-test schema
    // it names still exists. A failed statement counts too: a bind node-postgres cannot encode is
    // usually the reason it failed.
    const callbackIndex = args.findIndex(arg => typeof arg === 'function')

    if (callbackIndex >= 0) {
      const callback = args[callbackIndex]
      args[callbackIndex] = (err: unknown, result: unknown) => record(text, values).finally(() => callback(err, result))
      return query.apply(this, args)
    }

    return query.apply(this, args).then(
      async (result: unknown) => {
        await record(text, values)
        return result
      },
      async (err: unknown) => {
        await record(text, values)
        throw err
      }
    )
  } as typeof pg.Client.prototype.query

  afterAll(async () => {
    await describing
    await side?.end().catch(() => {})
    side = undefined
    sideReady = undefined

    if (sideError) {
      const error = sideError
      sideError = undefined
      statements.clear()
      throw new Error(`bind audit could not connect, so it checked nothing: ${error.message}`, { cause: error })
    }

    const report = new Set<string>()

    for (const [key, statement] of statements) {
      if (!statement.types) continue

      for (const signature of statement.signatures) {
        const kinds = signature.split(',') as ReturnType<typeof kindOf>[]

        for (const finding of checkBinds(statement.text, statement.types, kinds)) {
          report.add(`${finding.rule}: $${finding.param} is ${finding.type}, bound as ${finding.kind}. ${finding.fix}\n    ${key.slice(0, 200)}`)
        }
      }
    }

    statements.clear()

    if (report.size) {
      throw new Error(`bind audit: ${report.size} statement(s) another driver cannot carry\n  ${[...report].join('\n  ')}`)
    }
  })
}
