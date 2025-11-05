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

function delay (ms: number, error?: string): AbortablePromise<void> {
  const ac = new AbortController()

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

async function resolveWithinSeconds<T> (promise: Promise<T>, seconds: number, message?: string): Promise<T | void> {
  const timeout = Math.max(1, seconds) * 1000
  const reject = delay(timeout, message)

  let result

  try {
    result = await Promise.race([promise, reject])
  } finally {
    reject.abort()
  }

  return result
}

export {
  delay,
  resolveWithinSeconds,
  unwrapSQLResult
}
