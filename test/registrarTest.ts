import { it } from 'vitest'
import { expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import Registrar from '../src/registrar.ts'
import { TestClock } from '../src/clock.ts'
import type Manager from '../src/manager.ts'
import * as plans from '../src/plans.ts'
import type * as types from '../src/types.ts'

// The registrar against a database that answers each of its statements as a test says, for the
// failures and races a real one does not produce on demand.
const schema = 'registrar_test'
const HEARTBEAT_SECONDS = 10

type Statement = 'register' | 'countCrashRestarts' | 'crashRecountAt' | 'prune' | 'heartbeat' | 'stop' | 'getInstances'
type Handler = (values?: unknown[]) => Promise<{ rows: any[] }>

const statements: Record<Statement, string> = {
  register: plans.registerInstance(schema),
  countCrashRestarts: plans.countCrashRestarts(schema),
  crashRecountAt: plans.crashRecountAt(schema),
  prune: plans.pruneInstanceLives(schema, plans.INSTANCE_DEAD_KEPT_PER_NAME),
  heartbeat: plans.heartbeatInstance(schema),
  stop: plans.stopInstance(schema),
  getInstances: plans.getInstances(schema)
}

function setup (handlersFor: (clock: TestClock) => Partial<Record<Statement, Handler>> = () => ({})) {
  const clock = new TestClock()
  const handlers = handlersFor(clock)
  const calls: Statement[] = []
  const db: types.IDatabase = {
    async executeSql (text: string, values?: unknown[]) {
      const statement = (Object.keys(statements) as Statement[]).find(s => statements[s] === text)
      if (!statement) throw new Error(`unexpected statement: ${text}`)
      calls.push(statement)
      return handlers[statement] ? await handlers[statement](values) : { rows: [] }
    }
  }

  const manager = { getWipData: () => [] } as unknown as Manager
  const config = {
    schema,
    clock,
    registerInstance: true,
    instanceHeartbeatSeconds: HEARTBEAT_SECONDS
  } as unknown as types.ResolvedConstructorOptions

  const registrar = new Registrar('00000000-0000-0000-0000-000000000001', db, manager, config)
  const errors: Error[] = []
  registrar.on('error', err => errors.push(err))

  const count = (statement: Statement) => calls.filter(c => c === statement).length

  return { registrar, clock, errors, count }
}

describe('registrar', function () {
  it('emits a failed registration and still starts its heartbeat, which puts the row back', async function () {
    const { registrar, clock, errors, count } = setup(() => ({
      register: async () => { throw new Error('register boom') }
    }))

    await registrar.start()
    expect(errors.map(e => e.message)).toEqual(['register boom'])

    // A beat samples the process before it writes, so the statement goes out after the tick returns.
    await clock.tick(HEARTBEAT_SECONDS * 1000)
    await helper.until(() => count('heartbeat') === 1)

    await registrar.stop()
  })

  it('does not stack a heartbeat on one still running, and emits one that fails', async function () {
    let fail!: (err: Error) => void
    const { registrar, clock, errors, count } = setup(() => ({
      heartbeat: () => new Promise((resolve, reject) => { fail = reject })
    }))

    await registrar.start()
    await clock.tick(HEARTBEAT_SECONDS * 1000)
    await helper.until(() => count('heartbeat') === 1)

    // Long enough for a second beat to have sampled and written, had it started.
    await clock.tick(HEARTBEAT_SECONDS * 1000)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(count('heartbeat')).toBe(1)

    fail(new Error('heartbeat boom'))
    await registrar.stop()
    expect(errors.map(e => e.message)).toEqual(['heartbeat boom'])
  })

  it('cancels a crash recount still waiting when it stops', async function () {
    const { registrar, clock, count } = setup(clock => ({
      crashRecountAt: async () => ({ rows: [{ recountAt: new Date(clock.now() + 5000) }] })
    }))

    await registrar.start()
    expect(count('countCrashRestarts')).toBe(1)

    await registrar.stop()
    await clock.tick(60_000)
    expect(count('countCrashRestarts')).toBe(1)
  })

  it('emits a crash recount that fails', async function () {
    let recounts = 0
    const { registrar, clock, errors } = setup(clock => ({
      countCrashRestarts: async () => {
        if (recounts++ > 0) throw new Error('recount boom')
        return { rows: [] }
      },
      crashRecountAt: async () => ({ rows: [{ recountAt: new Date(clock.now() + 5000) }] })
    }))

    await registrar.start()
    await clock.tick(6_000)
    expect(errors.map(e => e.message)).toEqual(['recount boom'])

    await registrar.stop()
  })

  it('parses json and numbers an adapter returns as text', async function () {
    const { registrar } = setup(() => ({
      getInstances: async () => ({
        rows: [{
          pid: '42',
          heartbeatSeconds: '30',
          poolMax: '10',
          poolTotal: null,
          poolIdle: undefined,
          poolWaiting: '0',
          workers: '[{"queue":"q"}]',
          metrics: '{"cpu":0.5}',
          config: '{"adapter":"custom"}',
          crashRestarts: '2'
        }]
      })
    }))

    const [row] = await registrar.getInstances()

    expect(row.pid).toBe(42)
    expect(row.poolMax).toBe(10)
    expect(row.poolTotal).toBeNull()
    expect(row.poolIdle).toBeNull()
    expect(row.poolWaiting).toBe(0)
    expect(row.workers).toEqual([{ queue: 'q' }])
    expect(row.metrics).toEqual({ cpu: 0.5 })
    expect(row.config).toEqual({ adapter: 'custom' })
    expect(row.crashRestarts).toBe(2)
  })
})
