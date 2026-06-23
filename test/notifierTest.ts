import { describe, it, expect } from 'vitest'
import Notifier from '../src/notifier.ts'
import type { IDatabase } from '../src/types.ts'

// Unit-level coverage of the Notifier lifecycle and degradation paths. A fake
// db/manager lets us drive the listen-failure and close-failure branches that a
// live connection won't reliably produce.

const config = { schema: 'pgboss' } as any
const fakeManager = { notifyQueue () {}, forceFetchLnWorkers () {} } as any

function fakeDb (over: Partial<IDatabase>): IDatabase {
  return {
    executeSql: async () => ({ rows: [{ channel: 'pgboss_chan' }] } as any),
    ...over
  } as IDatabase
}

describe('notifier', function () {
  it('start is idempotent and stop is idempotent', async function () {
    let closes = 0
    const db = fakeDb({ listen: async () => ({ close: async () => { closes++ } }) })
    const notifier = new Notifier(db, fakeManager, config)

    await notifier.start()
    await notifier.start() // already started: returns early

    await notifier.stop()
    await notifier.stop() // already stopped: returns early

    expect(closes).toBe(1)
  })

  it('warns and continues when establishing the listener throws', async function () {
    const db = fakeDb({ listen: async () => { throw new Error('listen failed') } })
    const notifier = new Notifier(db, fakeManager, config)

    const warnings: any[] = []
    notifier.on('warning', w => warnings.push(w))

    await notifier.start()

    expect(warnings).toHaveLength(1)
    expect(warnings[0].data.type).toBe('listen_notify_unavailable')
    expect(warnings[0].data.error).toBe('listen failed')

    await notifier.stop()
  })

  it('available reflects the listener handle lifecycle', async function () {
    const db = fakeDb({ listen: async () => ({ close: async () => {} }) })
    const notifier = new Notifier(db, fakeManager, config)

    expect(notifier.available).toBe(false) // before start

    await notifier.start()
    expect(notifier.available).toBe(true) // handle established

    await notifier.stop()
    expect(notifier.available).toBe(false) // after stop
  })

  it('skips the listener and warns on a backend without LISTEN/NOTIFY', async function () {
    let listened = false
    const db = fakeDb({ listen: async () => { listened = true; return { close: async () => {} } } })
    const notifier = new Notifier(db, fakeManager, { schema: 'pgboss', backend: 'cockroachdb', noListenNotify: true } as any)

    const warnings: any[] = []
    notifier.on('warning', w => warnings.push(w))

    await notifier.start()

    expect(listened).toBe(false) // never attempts to listen
    expect(notifier.available).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].data.type).toBe('listen_notify_unavailable')
    expect(warnings[0].data.backend).toBe('cockroachdb')

    await notifier.stop()
  })

  it('available stays false when the database does not support listen', async function () {
    const db = fakeDb({}) // no listen function
    const notifier = new Notifier(db, fakeManager, config)

    const warnings: any[] = []
    notifier.on('warning', w => warnings.push(w))

    await notifier.start()

    expect(notifier.available).toBe(false)
    expect(warnings[0].data.type).toBe('listen_notify_unavailable')
  })

  it('available stays false when establishing the listener throws', async function () {
    const db = fakeDb({ listen: async () => { throw new Error('listen failed') } })
    const notifier = new Notifier(db, fakeManager, config)
    notifier.on('warning', () => {})

    await notifier.start()

    expect(notifier.available).toBe(false)
  })

  it('emits an error when closing the listen handle fails', async function () {
    const db = fakeDb({ listen: async () => ({ close: async () => { throw new Error('close failed') } }) })
    const notifier = new Notifier(db, fakeManager, config)

    const errors: any[] = []
    notifier.on('error', e => errors.push(e))

    await notifier.start()
    await notifier.stop()

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('close failed')
  })
})
