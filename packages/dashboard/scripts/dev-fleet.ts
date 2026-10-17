/**
 * A fleet of real pg-boss processes to leave running beside the dashboard: producers, workers, a
 * scheduler, a supervisor with a mismatched option, a queue nobody works, CPU and event-loop
 * pressure, and a worker that crashes on a loop.
 *
 *   npm run dev:fleet                          # every member, against pgboss_dev
 *   npm run dev:fleet -- --only api,email-worker
 *   npm run dev:fleet -- --no-crash            # leave out the crash loop
 *
 * Where `dev-instances.ts` writes a fixed picture of every state, this is the behavior over time:
 * metrics and jobs in hand that move between heartbeats, jobs that complete, connections held in
 * `pg_stat_activity`, and crash restarts the registrar counts itself. Each member is its own
 * process, so pids and vitals are real. Ctrl-C stops every member through stop(), so their rows read
 * stopped rather than quiet.
 *
 * It sends to and works the worker queues the whole time, so their counts do not stay as the seed
 * left them. Seed first (`npm run dev:init-db`): the worker queues come from there.
 *
 * | Member | What it shows |
 * | --- | --- |
 * | `scheduler` | Supervisor and scheduler, `persistQueueStats` on, no workers |
 * | `api` | Producer only; steady sends to the worker queues, an email surge for 20 s every 3 minutes, and sends to `orphan-exports`, which nobody works (stalled, uncovered) |
 * | `email-worker` x2 | Two processes under one name; 2% failures |
 * | `billing-worker` | Pool of 2 under a concurrency of 6; 10% failures |
 * | `report-worker` | CPU-bound jobs that hold the event loop for seconds |
 * | `ops-worker` | A second supervisor with `monitorIntervalSeconds: 30` (config mismatch) |
 * | `flaky-worker` | Exits without `stop()` every 40 to 80 s and is restarted (crash restarts, restart loop) |
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PgBoss, type ConstructorOptions } from 'pg-boss'

function arg (name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/pgboss'
const schema = process.env.PGBOSS_SCHEMA || 'pgboss_dev'

const ORPHAN_QUEUE = 'orphan-exports'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const between = (min: number, max: number) => min + Math.random() * (max - min)

/** Holds the thread, so the event loop and CPU columns have something to show. */
function burn (ms: number) {
  const end = Date.now() + ms
  let x = 0
  while (Date.now() < end) x += Math.sqrt(x + 1)
  return x
}

interface Member {
  name: string
  /** Processes started under this name. */
  count?: number
  options: ConstructorOptions
  run (boss: PgBoss): Promise<void>
  /** Exits without stop() after this many seconds, and the launcher restarts it. */
  crashAfter?: [number, number]
}

const members: Member[] = [
  {
    name: 'scheduler',
    options: { supervise: true, schedule: true, persistQueueStats: true, persistWarnings: true },
    async run () {}
  },
  {
    name: 'api',
    options: { supervise: false, schedule: false, max: 4 },
    async run (boss) {
      await boss.createQueue(ORPHAN_QUEUE)
      const rates: Array<[string, number, () => object, object?]> = [
        ['email-notifications', 3, () => ({ to: `user${Math.floor(Math.random() * 1000)}@example.com` })],
        ['payment-processing', 1, () => ({ orderId: Math.floor(Math.random() * 1e6), amount: +(Math.random() * 200).toFixed(2) })],
        ['user-sync', 0.3, () => ({ userId: Math.floor(Math.random() * 500) })],
        ['report-generation', 0.1, () => ({ reportType: 'daily' })],
        ['cleanup-tasks', 0.2, () => ({ target: 'temp-files' })],
        ['tenant-jobs', 0.5, () => ({ action: 'sync-users' }), { group: { id: `tenant-${['acme', 'globex', 'initech'][Math.floor(Math.random() * 3)]}` } }],
        [ORPHAN_QUEUE, 0.2, () => ({ format: 'csv' })]
      ]
      // A burst every few minutes on email, so the stats charts and health verdicts move.
      let tick = 0
      for (;;) {
        tick++
        const surge = tick % 180 < 20 ? 6 : 1
        for (const [queue, perSecond, data, options] of rates) {
          const n = Math.floor(perSecond * (queue === 'email-notifications' ? surge : 1) + Math.random())
          for (let i = 0; i < n; i++) await boss.send(queue, data(), options)
        }
        await sleep(1000)
      }
    }
  },
  {
    name: 'email-worker',
    count: 2,
    options: { supervise: false, schedule: false },
    async run (boss) {
      await boss.work('email-notifications', { localConcurrency: 4 }, async () => {
        await sleep(between(200, 900))
        if (Math.random() < 0.02) throw new Error('smtp timeout')
      })
    }
  },
  {
    name: 'billing-worker',
    // A small pool under more concurrency than it can hold, for the pool column.
    options: { supervise: false, schedule: false, max: 2 },
    async run (boss) {
      await boss.work('payment-processing', { localConcurrency: 6, batchSize: 1 }, async () => {
        await sleep(between(500, 2500))
        if (Math.random() < 0.1) throw new Error('card declined')
      })
    }
  },
  {
    name: 'report-worker',
    options: { supervise: false, schedule: false },
    async run (boss) {
      await boss.work('report-generation', async () => { burn(between(1500, 4000)) })
      await boss.work('user-sync', { localConcurrency: 2 }, async () => {
        burn(between(100, 400))
        await sleep(between(200, 600))
      })
    }
  },
  {
    name: 'ops-worker',
    // A second supervisor on a different monitor interval, for the config mismatch warning.
    options: { supervise: true, schedule: false, persistQueueStats: true, monitorIntervalSeconds: 30 },
    async run (boss) {
      await boss.work('cleanup-tasks', async () => { await sleep(between(100, 300)) })
      await boss.work('tenant-jobs', { localConcurrency: 2, groupConcurrency: 1 }, async () => {
        await sleep(between(300, 1200))
      })
    }
  },
  {
    name: 'flaky-worker',
    options: { supervise: false, schedule: false },
    crashAfter: [40, 80],
    async run (boss) {
      await boss.work('payment-processing', { localConcurrency: 2 }, async () => {
        await sleep(between(500, 1500))
      })
    }
  }
]

async function runMember (member: Member) {
  const boss = new PgBoss({ connectionString, schema, instanceName: member.name, ...member.options })
  boss.on('error', (err: Error) => console.error(`error: ${err.message}`))
  await boss.start()
  console.log(`started (pid ${process.pid})`)

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    await boss.stop({ graceful: true, timeout: 5000 }).catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  if (member.crashAfter) {
    const seconds = between(...member.crashAfter)
    setTimeout(() => {
      console.log(`crashing after ${Math.round(seconds)}s, without stop()`)
      process.exit(1)
    }, seconds * 1000)
  }

  await member.run(boss)
}

function launch () {
  const only = arg('only')?.split(',')
  const noCrash = process.argv.includes('--no-crash')
  const chosen = members.filter(m => (!only || only.includes(m.name)) && !(noCrash && m.crashAfter))
  const unknown = only?.filter(name => !members.some(m => m.name === name)) ?? []
  if (unknown.length) {
    console.error(`unknown member: ${unknown.join(', ')}; members are ${members.map(m => m.name).join(', ')}`)
    process.exit(1)
  }

  const self = fileURLToPath(import.meta.url)
  const tsx = join(self, '..', '..', 'node_modules', '.bin', 'tsx')
  const children = new Set<ChildProcess>()
  let shuttingDown = false

  // Each member inherits the environment, so DATABASE_URL, PGBOSS_SCHEMA and any NODE_OPTIONS reach it.
  const start = (member: Member, index: number) => {
    const label = member.count && member.count > 1 ? `${member.name}#${index + 1}` : member.name
    const child = spawn(tsx, [self, '--member', member.name], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    const prefix = (chunk: Buffer) => chunk.toString().trimEnd().split('\n').map(line => `[${label}] ${line}`).join('\n')
    child.stdout!.on('data', chunk => console.log(prefix(chunk)))
    child.stderr!.on('data', chunk => console.error(prefix(chunk)))
    child.on('exit', code => {
      children.delete(child)
      if (shuttingDown) return
      console.log(`[${label}] exited with ${code}; restarting in 3s`)
      setTimeout(() => start(member, index), 3000)
    })
  }

  for (const member of chosen) {
    for (let i = 0; i < (member.count ?? 1); i++) start(member, i)
  }
  console.log(`fleet: ${chosen.map(m => m.count && m.count > 1 ? `${m.name} x${m.count}` : m.name).join(', ')} on ${schema}; Ctrl-C stops them all`)

  const stopAll = () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('stopping the fleet...')
    for (const child of children) child.kill('SIGTERM')
    const deadline = setTimeout(() => process.exit(0), 10000)
    const wait = setInterval(() => {
      if (children.size === 0) {
        clearInterval(wait)
        clearTimeout(deadline)
        process.exit(0)
      }
    }, 200)
  }
  process.on('SIGINT', stopAll)
  process.on('SIGTERM', stopAll)
}

const memberName = arg('member')
if (memberName) {
  const member = members.find(m => m.name === memberName)
  if (!member) throw new Error(`unknown member ${memberName}`)
  runMember(member).catch(err => {
    console.error(err)
    process.exit(1)
  })
} else {
  launch()
}
