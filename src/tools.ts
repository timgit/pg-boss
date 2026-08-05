import { setTimeout } from 'node:timers/promises'

/**
 * When sql contains multiple queries, result is an array of objects with rows property
 * This function unwraps the result into a single object with rows property
 *
 * Some drivers (e.g. postgres.js) instead return the rows themselves as a flat array. Those
 * elements have no `rows` property, so treat the array as the row set rather than flat-mapping
 * undefined into it.
*/
function unwrapSQLResult (result: { rows: any[] } | { rows: any[] }[] | any[]): { rows: any[] } {
  if (Array.isArray(result)) {
    return result.every(i => Array.isArray(i?.rows))
      ? { rows: result.flatMap(i => i.rows) }
      : { rows: result }
  }

  return result
}

export interface AbortablePromise<T> extends Promise<T> {
  abort: () => void
}

function delay (ms: number, error?: string, abortController?: AbortController): AbortablePromise<void> {
  const ac = abortController || new AbortController()

  const promise = new Promise<void>((resolve, reject) => {
    setTimeout(ms, null, { signal: ac.signal })
      .then(() => {
        if (error) {
          reject(new Error(error))
        } else {
          resolve()
        }
      })
      .catch(resolve)
  }) as AbortablePromise<void>

  promise.abort = () => {
    if (!ac.signal.aborted) {
      ac.abort()
    }
  }

  return promise
}

async function resolveWithinSeconds<T> (promise: Promise<T>, seconds: number, message?: string, abortController?: AbortController): Promise<T | void> {
  const timeout = Math.max(1, seconds) * 1000
  const reject = delay(timeout, message, abortController)

  let result

  try {
    result = await Promise.race([promise, reject])
  } finally {
    reject.abort()
  }

  return result
}

// a quoted name whose contents are already a legal bare identifier *and* already lower case, so
// postgres would resolve the two spellings to the same schema.
const REDUNDANTLY_QUOTED_SCHEMA_REGEX = /^"[a-z_][a-z0-9_]*"$/

const isQuoted = (schema: string) => schema.startsWith('"') && schema.endsWith('"') && schema.length > 1

/**
 * Resolves a configured schema string to the name postgres actually stores in the catalog.
 *
 * the `schema` option is interpolated verbatim into identifier positions, so a caller may quote it
 * to reach names that are not legal bare identifiers, e.g. `'"My-Schema"'`. The catalog holds the
 * *resolved* name, so any comparison against `pg_namespace.nspname` (and anything else reading a
 * name back out of postgres) needs this rather than the raw config value.
 *
 * A quoted name resolves to its contents verbatim; a bare one is folded to lower case, as postgres
 * does on the way in. So `"MySchema"` and `MySchema` are different schemas, the latter stored as
 * `myschema`.
 *
 * Do NOT use this to derive the notify channel or the advisory lock - see normalizeSchemaName.
 */
function resolveSchemaName (schema: string): string {
  return isQuoted(schema) ? schema.slice(1, -1) : schema.toLowerCase()
}

/**
 * Canonicalizes a configured schema string for the values bun-boss *derives* from it rather than
 * looks up: the notify channel name and the advisory lock key.
 *
 * Those are hashes of a string, never compared against the catalog - the channel literal is
 * generated from the same expression for both LISTEN and NOTIFY, and the advisory key is opaque to
 * postgres. So the only requirement is that every instance pointed at the same physical schema
 * agrees, which means the *sole* transform needed is collapsing quoting that carries no meaning:
 * `'"pgboss"'` and `'pgboss'` are one schema and must not end up on separate channels.
 *
 * Deliberately NOT resolveSchemaName. Folding a bare `MySchema` to `myschema` would also be
 * "correct", but it changes the channel and lock key for a name that has always been legal, so a
 * rolling upgrade would leave old and new instances failing to coordinate. Leaving bare names
 * untouched keeps the derived values byte-identical to every prior release.
 */
function normalizeSchemaName (schema: string): string {
  return REDUNDANTLY_QUOTED_SCHEMA_REGEX.test(schema) ? schema.slice(1, -1) : schema
}

export {
  delay,
  normalizeSchemaName,
  resolveSchemaName,
  resolveWithinSeconds,
  unwrapSQLResult
}
