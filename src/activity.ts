import { setImmediate } from 'node:timers/promises'
import type { IDatabase, TransactionHandle } from './types.ts'

const originals = new WeakMap<object, IDatabase>()

/**
 * The db a tracked one wraps, or the db itself if it is not tracked. What a transactional handler
 * is given, since a handler's statements are not pg-boss's to wait for.
 */
export function untracked<D extends IDatabase> (db: D): D {
  return (originals.get(db) as D | undefined) ?? db
}

/**
 * Counts the statements pg-boss has in flight, so a TestClock can let them finish before it moves
 * time on. PgBoss wraps its db with this only when its clock is attachable.
 */
export function trackActivity<T extends IDatabase> (db: T): { db: T, idle: () => Promise<boolean> } {
  let inFlight = 0
  let started = 0
  let waiters: (() => void)[] = []

  const track = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    inFlight++
    started++
    try {
      return await fn(...args)
    } finally {
      inFlight--
      if (inFlight === 0) {
        const settled = waiters
        waiters = []
        for (const resolve of settled) resolve()
      }
    }
  }

  // Bound to the original, so an adapter's private fields still work through the proxy.
  const wrap = <O extends object>(target: O, overrides: Record<PropertyKey, unknown>): O => new Proxy(target, {
    get (t, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key]
      const value = Reflect.get(t, key)
      return typeof value === 'function' ? value.bind(t) : value
    },
    // A caller that patches a counted method has usually captured the tracked one to call through.
    // Writing the patch onto the original instead would make the tracked one call the patch forever.
    set (t, key, value) {
      if (Object.hasOwn(overrides, key)) {
        overrides[key] = value
        return true
      }
      return Reflect.set(t, key, value)
    }
  })

  const wrapDb = <D extends IDatabase>(inner: D): D => {
    const overrides: Record<PropertyKey, unknown> = {
      executeSql: track((text: string, values?: unknown[]) => inner.executeSql(text, values))
    }
    // Only when present: callers detect the capability with typeof.
    if (typeof inner.beginTransaction === 'function') {
      overrides.beginTransaction = track(async () => wrapTransaction(await inner.beginTransaction!()))
    }
    // pg-boss's own pool runs multi-statement work through this, and it begins the transaction on
    // the original, past the override above, so the whole call is counted as one.
    const withTransaction = (inner as { withTransaction?: unknown }).withTransaction
    if (typeof withTransaction === 'function') {
      overrides.withTransaction = track((fn: (db: IDatabase) => Promise<unknown>) => withTransaction.call(inner, fn))
    }
    const tracked = wrap(inner, overrides)
    originals.set(tracked, inner)
    return tracked
  }

  // The open transaction is not counted, only each call on it, or a transactional handler's whole
  // run would read as busy.
  const wrapTransaction = (tx: TransactionHandle): TransactionHandle => wrap(tx, {
    db: wrapDb(tx.db),
    commit: track(() => tx.commit()),
    rollback: track(() => tx.rollback())
  })

  async function idle (): Promise<boolean> {
    let waited = false
    for (;;) {
      if (inFlight > 0) {
        waited = true
        await new Promise<void>(resolve => waiters.push(resolve))
        continue
      }
      // A caller whose statement just settled runs on in microtasks: it either arms a timer or
      // starts another statement before this turn ends.
      const seen = started
      await setImmediate()
      if (inFlight === 0 && started === seen) return waited
      waited = true
    }
  }

  return { db: wrapDb(db), idle }
}
