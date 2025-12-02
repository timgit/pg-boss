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

export interface ExtendableAbortablePromise<T> extends Promise<T> {
  abort: () => void
  extend: (newDurationMs: number) => void
}

// Keep backward compatibility
export type AbortablePromise<T> = ExtendableAbortablePromise<T>

function delay (ms: number, error?: string, abortController?: AbortController): ExtendableAbortablePromise<void> {
  const ac = abortController || new AbortController()
  let currentTimeoutId: ReturnType<typeof setTimeout>
  let settled = false

  let resolveRef: () => void
  let rejectRef: (err: Error) => void

  const scheduleTimeout = (timeoutMs: number) => {
    currentTimeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      if (error) {
        rejectRef(new Error(error))
      } else {
        resolveRef()
      }
    }, timeoutMs)
  }

  const onAbort = () => {
    if (settled) return
    settled = true
    clearTimeout(currentTimeoutId)
    resolveRef()
  }

  const promise = new Promise<void>((resolve, reject) => {
    resolveRef = resolve
    rejectRef = reject
    scheduleTimeout(ms)

    ac.signal.addEventListener('abort', onAbort, { once: true })
  }) as ExtendableAbortablePromise<void>

  promise.abort = () => {
    if (!ac.signal.aborted) {
      ac.abort()
    }
  }

  promise.extend = (newDurationMs: number) => {
    if (settled) return
    clearTimeout(currentTimeoutId)
    scheduleTimeout(newDurationMs)
  }

  return promise
}

export interface ExtendableTimeout<T> {
  promise: Promise<T | void>
  abort: () => void
  extend: (newDurationMs: number) => void
}

function resolveWithinSeconds<T> (promise: Promise<T>, seconds: number, message?: string, abortController?: AbortController): ExtendableTimeout<T> {
  const timeout = Math.max(1, seconds) * 1000
  const timeoutPromise = delay(timeout, message, abortController)

  const racePromise = (async () => {
    let result
    try {
      result = await Promise.race([promise, timeoutPromise])
    } finally {
      timeoutPromise.abort()
    }
    return result
  })()

  return {
    promise: racePromise,
    abort: () => timeoutPromise.abort(),
    extend: (newDurationMs: number) => timeoutPromise.extend(newDurationMs)
  }
}

export {
  delay,
  resolveWithinSeconds,
  unwrapSQLResult
}
