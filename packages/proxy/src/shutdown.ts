export type ShutdownHandler = () => void | Promise<void>

export type ShutdownAdapter<Signal> = {
  on: (signal: Signal, handler: () => void) => void
  off?: (signal: Signal, handler: () => void) => void
}

type DenoSignal = 'SIGINT' | 'SIGTERM' | string

type DenoLike = {
  addSignalListener: (signal: DenoSignal, handler: () => void) => void
  removeSignalListener: (signal: DenoSignal, handler: () => void) => void
}

export const nodeShutdownAdapter: ShutdownAdapter<NodeJS.Signals> = {
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.off(signal, handler)
}

export const bunShutdownAdapter = nodeShutdownAdapter

export function createDenoShutdownAdapter (): ShutdownAdapter<DenoSignal> {
  const deno = (globalThis as unknown as { Deno?: DenoLike }).Deno
  if (!deno) {
    throw new Error('Deno global is not available in this runtime.')
  }
  return {
    on: (signal, handler) => deno.addSignalListener(signal, handler),
    off: (signal, handler) => deno.removeSignalListener(signal, handler)
  }
}

export function attachShutdownListeners <Signal> (
  signals: Signal[],
  adapter: ShutdownAdapter<Signal>,
  handler: ShutdownHandler
) {
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
