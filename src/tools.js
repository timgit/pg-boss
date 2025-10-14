const { setTimeout } = require('node:timers/promises')

module.exports = {
  delay,
  resolveWithinSeconds
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
