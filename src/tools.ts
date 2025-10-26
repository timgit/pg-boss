import { setTimeout } from 'node:timers/promises'

export {
  delay,
  resolveWithinSeconds,
  unwrapSQLResult
}

/**
 * When sql contains multiple queries, result is an array of objects with rows property
 * This function unwraps the result into a single object with rows property
 * @param {{rows: Array<Object>} | Array<{rows: Array<Object>}>} result
 * @returns {{rows: Array<Object>}}
*/
function unwrapSQLResult (result) {
  if (result instanceof Array) {
    return { rows: result.flatMap(i => i.rows) }
  }

  return result
}

function delay (ms, error) {
  const ac = new AbortController()

  const promise = new Promise((resolve, reject) => {
    setTimeout(ms, null, { signal: ac.signal })
      .then(() => {
        if (error) {
          reject(new Error(error))
        } else {
          resolve()
        }
      })
      .catch(resolve)
  })

  promise.abort = () => {
    if (!ac.signal.aborted) {
      ac.abort()
    }
  }

  return promise
}

async function resolveWithinSeconds (promise, seconds, message) {
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
