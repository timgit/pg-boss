import { setTimeout } from 'node:timers/promises'

export function delay(ms: number, error?: string): Promise<void> & { abort: () => void } {
  const ac = new AbortController()

  const promise = new Promise<void>((resolve, reject) => {
    setTimeout(ms, null, { signal: ac.signal })
      .then(() => {
        if (typeof error === 'string') {
          reject(new Error(error))
        } else {
          resolve()
        }
      })
      .catch(resolve)
  })

  Object.defineProperty(promise, 'abort', {
    value: () => {
      if (!ac.signal.aborted) {
        ac.abort()
      }
    },
    writable: false,
    configurable: false,
    enumerable: false
  })

  return promise as Promise<void> & { abort: () => void }
}

export async function resolveWithinSeconds<T extends Promise<unknown>>(promise: T, seconds: number, message?: string): Promise<Awaited<T> | Awaited<ReturnType<typeof delay>>> {
  const timeout = Math.max(1, seconds) * 1000
  const reject = delay(timeout, message)

  let result: Awaited<T> | Awaited<ReturnType<typeof delay>>

  try {
    result = await Promise.race([promise, reject])
  } finally {
    reject.abort()
  }

  return result
}
