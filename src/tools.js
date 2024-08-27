module.exports = {
  delay
}

function delay (ms, error) {
  const { setTimeout } = require('node:timers/promises')
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
