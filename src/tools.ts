import { setTimeout } from 'node:timers/promises'

/**
 * When sql contains multiple queries, result is an array of objects with rows property
 * This function unwraps the result into a single object with rows property
*/
function unwrapSQLResult (result: { rows: any[] } | { rows: any[] }[]): { rows: any[] } {
  if (Array.isArray(result)) {
    return { rows: result.flatMap(i => i.rows) }
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

async function resolveWithinSeconds<T, M extends string | undefined> (promise: Promise<T> | T, seconds: number, message?: M, abortController?: AbortController): Promise<M extends string ? T : T | undefined> {
  const timeout = Math.max(1, seconds) * 1000
  const reject = delay(timeout, message, abortController)

  let result

  try {
    result = await Promise.race([promise, reject])
  } finally {
    reject.abort()
  }

  // The type assertion is justified by the implementation above. If a message is given, the `reject` promise will throw and therefore never return.
  return result as M extends string ? T : undefined | T
}

export {
  delay,
  resolveWithinSeconds,
  unwrapSQLResult
}
