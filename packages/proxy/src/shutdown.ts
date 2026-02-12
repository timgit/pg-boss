export type ShutdownHandler = () => void | Promise<void>

export type ShutdownAdapter<Signal> = {
  on: (signal: Signal, handler: () => void) => void
  off?: (signal: Signal, handler: () => void) => void
}

export const attachShutdownListeners = <Signal>(
  signals: Signal[],
  adapter: ShutdownAdapter<Signal>,
  handler: ShutdownHandler
) => {
  let called = false
  const wrapped = () => {
    if (called) return
    called = true
    Promise.resolve(handler()).catch((err) => {
      console.error('Shutdown handler error:', err)
    })
  }

  for (const signal of signals) {
    adapter.on(signal, wrapped)
  }

  return () => {
    if (!adapter.off) {
      return
    }
    for (const signal of signals) {
      adapter.off(signal, wrapped)
    }
  }
}
