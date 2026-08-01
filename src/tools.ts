import { setTimeout } from 'node:timers/promises'

/**
 * When sql contains multiple queries, result is an array of objects with rows property
 * This function unwraps the result into a single object with rows property
 *
 * Some drivers (postgres.js, and therefore drizzle-orm/postgres-js) instead return the rows
 * themselves as a flat array. Those elements have no `rows` property, so treat the array
 * as the row set rather than flat-mapping undefined into it.
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

/**
 * Resolves a configured schema string to the name postgres actually stores in the catalog.
 *
 * the `schema` option is interpolated verbatim into identifier positions, so a caller may quote it
 * to reach names that are not legal bare `'"My-Schema"'`. The catalog holds the *resolved* name,
 * so comparisons against `pg_namespace.nspname`, and the hashes deriving the notify channel and
 * advisory lock, need this rather than the raw config value.
 *
 * A quoted name resolves to its contents verbatim; a bare one is folded to lower case, as postgres
 * does on the way in. That makes `"pgboss"` and `pgboss` the same schema, sharing a channel and a
 * lock, while `"MySchema"` and `MySchema` stay distinct. The latter is stored as `myschema`.
 */
function resolveSchemaName (schema: string): string {
  return schema.startsWith('"') && schema.endsWith('"') && schema.length > 1
    ? schema.slice(1, -1).replaceAll('""', '"')
    : schema.toLowerCase()
}

export {
  delay,
  resolveSchemaName,
  resolveWithinSeconds,
  unwrapSQLResult
}
