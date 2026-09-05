/**
 * Initialize the development database: pg-boss schema, queues, and a dataset that
 * exercises everything the dashboard can draw.
 *
 * The script owns a schema of its own — `pgboss_dev` by default — and drops it
 * whole on every run, so repeated runs converge on the same dataset instead of
 * piling up jobs. The blast radius is that one schema. Nothing outside it is read
 * or written, so the queue names below are free to be ordinary-sounding without
 * colliding with anything real in the same database.
 *
 * `npm run dev`, `npm run dev:auth`, and `npm run dev:worker` all point at the same
 * schema, so the dashboard sees what this script wrote.
 *
 * Two populations, deliberately:
 *
 * - The first six queues carry ordinary fetchable jobs, so `npm run dev:worker`
 *   has something to process and you can watch jobs move.
 * - The `demo-*` queues hold jobs pinned in every state the UI knows how to render
 *   (active, completed, failed, retry, cancelled, dead-lettered). Their pending
 *   jobs use a far-future `startAfter`, so a running worker cannot drain them and
 *   the states stay put while you click around.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from 'pg'
import { PgBoss } from 'pg-boss'

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/pgboss'
const schema = process.env.PGBOSS_SCHEMA || 'pgboss_dev'

/**
 * This script drops its schema before seeding, so it must never be pointed at one
 * somebody keeps anything in. Two gates:
 *
 * - The name has to be a bare identifier, since it is interpolated into DDL.
 * - The name has to end in `_dev`, which is what makes the drop safe by
 *   construction. `PGBOSS_SEED_FORCE=1` overrides that for a scratch schema named
 *   something else, and is the only way to aim this at an arbitrary name.
 */
function assertDroppable (name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Refusing to seed schema "${name}": not a bare SQL identifier.`)
  }

  if (!name.endsWith('_dev') && process.env.PGBOSS_SEED_FORCE !== '1') {
    throw new Error(
      `Refusing to drop schema "${name}": this script recreates its schema from scratch ` +
      'and only does that to a name ending in "_dev". Set PGBOSS_SEED_FORCE=1 if you ' +
      'really mean this one.'
    )
  }
}

/** Drop the schema so every run starts from the same empty slate. pg-boss recreates it. */
async function resetSchema (): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()

  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  } finally {
    await client.end()
  }
}

const boss = new PgBoss({
  connectionString,
  schema,
  supervise: true,
  superviseIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
})

boss.on('error', (err) => console.error('pg-boss error:', err.message))

async function main () {
  assertDroppable(schema)

  console.log(`Resetting schema "${schema}"...`)
  await resetSchema()

  console.log('Installing pg-boss schema...')
  await boss.start()

  await seedWorkerQueues()
  await seedEveryJobState()
  await seedSchedules()

  // Let the supervisor move the dead-lettered jobs and the monitor refresh the
  // per-queue counters the queue list reads.
  console.log('  waiting for supervisor and monitor...')
  await sleep(4000)
  await boss.stop()

  await seedWarnings()
  await seedReadyHistory()

  console.log('\nDone. Start the dashboard with `npm run dev`.')
  console.log('Read-only mode:  PGBOSS_DASHBOARD_READ_ONLY=1 npm run dev')
  console.log('Process jobs:    npm run dev:worker (in a second terminal)')
}

/**
 * Queues with ordinary, fetchable work. The policies vary on purpose — the
 * dashboard renders a policy column, and singleton policies behave visibly
 * differently from `standard` under repeated sends.
 *
 * The names here are the ones `scripts/worker.ts` registers handlers for, so
 * renaming one means renaming it there too.
 */
async function seedWorkerQueues () {
  const queues = [
    { name: 'email-notifications', options: { policy: 'standard' } },
    { name: 'payment-processing', options: { policy: 'standard', retryLimit: 5 } },
    { name: 'report-generation', options: { policy: 'singleton' } },
    { name: 'user-sync', options: { policy: 'stately' } },
    { name: 'cleanup-tasks', options: { policy: 'short', expireInSeconds: 60 } },
    { name: 'tenant-jobs', options: { policy: 'standard' } },
  ] as const

  for (const { name, options } of queues) {
    await boss.createQueue(name, options)
  }

  await boss.send('email-notifications', { to: 'user@example.com', subject: 'Welcome!' })
  await boss.send('email-notifications', { to: 'admin@example.com', subject: 'Report ready' })
  await boss.send('payment-processing', { orderId: '12345', amount: 99.99 })
  await boss.send('report-generation', { reportType: 'monthly', month: 'January' })
  await boss.send('cleanup-tasks', { target: 'temp-files' })

  // Grouped jobs, so the dashboard's group and tier columns have something in them.
  await boss.send('tenant-jobs', { action: 'sync-users' }, { group: { id: 'tenant-acme' } })
  await boss.send('tenant-jobs', { action: 'sync-products' }, { group: { id: 'tenant-acme' } })
  await boss.send('tenant-jobs', { action: 'generate-invoice' }, { group: { id: 'tenant-acme', tier: 'premium' } })
  await boss.send('tenant-jobs', { action: 'sync-users' }, { group: { id: 'tenant-globex' } })
  await boss.send('tenant-jobs', { action: 'sync-inventory' }, { group: { id: 'tenant-globex', tier: 'standard' } })
  await boss.send('tenant-jobs', { action: 'backup-data' }, { group: { id: 'tenant-initech', tier: 'basic' } })

  console.log(`  worker queues: ${queues.length}, with jobs ready to process`)
}

/**
 * The `demo-*` queues, holding jobs in every state the dashboard renders.
 *
 * All `standard`: the singleton policies collapse repeated sends into a single
 * job, which is correct behaviour and useless here, where the point is to end up
 * with a countable number of jobs in each state.
 */
async function seedEveryJobState () {
  await boss.createQueue('demo-dlq', { policy: 'standard' })
  await boss.createQueue('demo-payments', {
    policy: 'standard',
    retryLimit: 2,
    retryDelay: 60,
    deadLetter: 'demo-dlq',
    warningQueueSize: 5,
  })
  await boss.createQueue('demo-exports', { policy: 'standard', retryLimit: 0, expireInSeconds: 120 })
  await boss.createQueue('demo-webhooks', { policy: 'standard', retryLimit: 3, retryBackoff: true })
  await boss.createQueue('demo-billing', { policy: 'standard', retryLimit: 1 })
  await boss.createQueue('demo-imports', { policy: 'standard', retryLimit: 0, deadLetter: 'demo-dlq' })

  // created — the far-future startAfter is what keeps these out of `dev:worker`'s
  // reach, so the dataset survives running a worker alongside the dashboard.
  for (let i = 0; i < 12; i++) {
    await boss.send('demo-payments',
      { orderId: `ord-${1000 + i}`, amount: Number((19.99 * (i + 1)).toFixed(2)), currency: 'USD' },
      { startAfter: 3600, priority: i % 4 })
  }

  // active — fetched and deliberately never completed. The only state whose row
  // offers Cancel but not Delete.
  for (let i = 0; i < 3; i++) {
    await boss.send('demo-exports', { report: `export-${i}`, rows: 5000 * (i + 1) })
  }
  const active = await boss.fetch('demo-exports', { batchSize: 3 })

  // completed — gives the metrics view some history to draw.
  for (let i = 0; i < 9; i++) {
    await boss.send('demo-webhooks', { url: `https://hooks.example.com/${i}`, attempt: 1 })
  }
  const completed = await boss.fetch('demo-webhooks', { batchSize: 9 })
  for (const job of completed) {
    await boss.complete('demo-webhooks', job.id, { status: 200, ms: 90 + (job.id.charCodeAt(0) % 200) })
  }

  // failed — terminal, because this queue's retryLimit is 0. Offers Retry.
  for (let i = 0; i < 4; i++) {
    await boss.send('demo-exports', { report: `broken-${i}`, rows: 0 })
  }
  const failed = await boss.fetch('demo-exports', { batchSize: 4 })
  for (const job of failed) {
    await boss.fail('demo-exports', job.id, {
      message: 'ETIMEDOUT: upstream did not respond within 30s',
      stack: 'Error: ETIMEDOUT\n    at Socket.onTimeout (node:net:589:8)',
    })
  }

  // retry — failed once against a retryLimit of 2, with a retryDelay long enough
  // that they stay visible in `retry` rather than becoming fetchable again.
  for (let i = 0; i < 3; i++) {
    await boss.send('demo-payments', { orderId: `ord-retry-${i}`, amount: 42.5 })
  }
  const retrying = await boss.fetch('demo-payments', { batchSize: 3 })
  for (const job of retrying) {
    await boss.fail('demo-payments', job.id, { message: 'card declined, will retry' })
  }

  // cancelled — offers Resume.
  const cancelIds: string[] = []
  for (let i = 0; i < 4; i++) {
    const id = await boss.send('demo-billing', { invoice: `inv-${300 + i}`, total: 120 * (i + 1) }, { startAfter: 3600 })
    if (id) cancelIds.push(id)
  }
  if (cancelIds.length) {
    await boss.cancel('demo-billing', cancelIds)
  }

  // dead letter — retryLimit 0 makes one failure terminal, so these land in
  // `demo-dlq` immediately instead of waiting out a retry delay.
  for (let i = 0; i < 5; i++) {
    await boss.send('demo-imports', { file: `customers-${i}.csv`, rows: 1200 * (i + 1) })
  }
  const dead = await boss.fetch('demo-imports', { batchSize: 5 })
  for (const job of dead) {
    await boss.fail('demo-imports', job.id, {
      message: 'CSV parse error at line 412: unexpected end of quoted field',
      file: (job.data as { file: string }).file,
    })
  }

  console.log(
    `  demo queues: 12 created, ${active.length} active, ${completed.length} completed, ` +
    `${failed.length} failed, ${retrying.length} retry, ${cancelIds.length} cancelled, ${dead.length} dead-lettered`
  )
}

async function seedSchedules () {
  await boss.schedule('demo-exports', '0 * * * *', { report: 'hourly-rollup' }, { tz: 'UTC' })
  await boss.schedule('demo-billing', '30 2 * * 1', { run: 'weekly-invoices' }, { tz: 'America/Chicago' })
  await boss.schedule('demo-webhooks', '*/15 * * * *', { ping: true })
  console.log('  schedules: 3')
}

/**
 * The warning table is written by a running pg-boss instance reacting to real
 * conditions, which is not reproducible on demand — so these rows are inserted
 * directly. They carry a `seed` marker so a re-run replaces its own rows and
 * leaves anything else in the table alone.
 */
async function seedWarnings () {
  const client = new Client({ connectionString })
  await client.connect()

  try {
    await client.query(`DELETE FROM ${schema}.warning WHERE data->>'seed' = 'demo'`)
    await client.query(`
      INSERT INTO ${schema}.warning (type, message, data, created_on) VALUES
        ('queue_backlog', 'Queue "demo-payments" backlog of 13 exceeds its warning size of 5',
         '{"seed":"demo","queue":"demo-payments","queued":13,"threshold":5}', now() - interval '4 minutes'),
        ('slow_query', 'Dashboard query exceeded 1000ms',
         '{"seed":"demo","ms":1420,"query":"getQueues"}', now() - interval '2 hours'),
        ('queue_backlog', 'Queue "demo-exports" backlog of 9 exceeds its warning size of 5',
         '{"seed":"demo","queue":"demo-exports","queued":9,"threshold":5}', now() - interval '1 day')
    `)
    console.log('  warnings: 3')
  } finally {
    await client.end()
  }
}

/** Blend the tail of a series toward `end` so it lands exactly there without a jump. */
function blendTail (series: number[], end: number, span = 6): number[] {
  const out = [...series]

  for (let k = 0; k < span; k++) {
    const idx = out.length - span + k
    if (idx < 0) continue
    const weight = (k + 1) / span
    out[idx] = Math.max(0, Math.round(out[idx] * (1 - weight) + end * weight))
  }

  return out
}

/**
 * Give each queue a shaped `ready_history` so the list sparklines show a trend.
 *
 * pg-boss appends one sample per monitor cycle and keeps the last
 * `READY_HISTORY_SIZE` (60) of them, newest first — see `READY_HISTORY_SIZE` and
 * `cacheQueueStats` in `src/plans.ts`. A dev database that has only run the
 * monitor a few times has a two- or three-point flat window, which draws a flat
 * line and shows nothing about the component.
 *
 * The shapes are written oldest-to-newest for legibility and reversed on the way
 * in. Each is blended into the queue's real current ready count, so the last point
 * of the sparkline agrees with the number rendered beside it.
 *
 * `user-sync` and `cleanup-tasks` are left deliberately flat: a flat series has a
 * zero range and takes a different path through the sparkline's normalization, so
 * it is worth having on the page next to the shaped ones. They are held at their
 * real ready count rather than blended toward it, since blending a constant series
 * into a non-zero count would turn it into a ramp.
 */
async function seedReadyHistory () {
  const WINDOW = 60
  const FLAT = new Set(['user-sync', 'cleanup-tasks'])

  const shapes: Record<string, (i: number) => number> = {
    // A backlog that built up and was then worked off.
    'demo-payments': (i) => Math.round(45 * Math.sin((i / WINDOW) * Math.PI)),
    // A steady plateau ending in a cliff — the shape a queue makes when workers
    // are scaled up.
    'demo-webhooks': (i) => (i < 44 ? 26 + ((i * 7) % 5) : Math.max(0, 26 - (i - 43) * 2)),
    // Bursty arrivals, each drained before the next.
    'demo-exports': (i) => Math.round(Math.abs(Math.sin(i / 3.5)) * (18 - i / 6)),
    // Low background noise, never much of a backlog.
    'demo-billing': (i) => (i * 13) % 4,
    // Flat until a single import spike, then back to nothing.
    'demo-imports': (i) => (i >= 30 && i <= 36 ? 22 - (i - 30) * 3 : 0),
    // Dead letters only accumulate, so this one is a staircase.
    'demo-dlq': (i) => Math.floor(i / 10),
    'email-notifications': (i) => Math.round(8 * Math.sin((i / WINDOW) * Math.PI) + (i % 3)),
    'payment-processing': (i) => Math.round(Math.abs(Math.sin(i / 4)) * 9),
    'report-generation': (i) => (i * 7) % 5,
    'tenant-jobs': (i) => (i < 40 ? 11 + ((i * 5) % 4) : Math.max(0, 11 - (i - 39))),
    // Held flat by FLAT above; the generator is never consulted for these.
    'user-sync': () => 0,
    'cleanup-tasks': () => 0,
  }

  const client = new Client({ connectionString })
  await client.connect()

  try {
    const { rows: columns } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'queue' AND column_name = 'ready_history'
       ) AS exists`,
      [schema]
    )

    if (!columns[0]?.exists) {
      console.log('  ready history: skipped (schema predates queue.ready_history)')
      return
    }

    // Read the counts back rather than assuming them: the monitor has just run,
    // and the last sample has to match whatever it recorded.
    const { rows: counts } = await client.query<{ name: string, ready_count: number }>(
      `SELECT name, ready_count FROM ${schema}.queue WHERE name = ANY($1)`,
      [Object.keys(shapes)]
    )

    let flat = 0

    for (const { name, ready_count: readyCount } of counts) {
      const shape = shapes[name]
      if (!shape) continue

      const count = Number(readyCount)
      const series = FLAT.has(name)
        ? Array.from({ length: WINDOW }, () => count)
        : blendTail(Array.from({ length: WINDOW }, (_, i) => shape(i)), count)
      if (new Set(series).size === 1) flat++

      await client.query(
        `UPDATE ${schema}.queue SET ready_history = $1::int[] WHERE name = $2`,
        [series.reverse(), name]
      )
    }

    console.log(`  ready history: ${counts.length} queues x ${WINDOW} samples (${flat} flat, on purpose)`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('Failed to initialize:', err.message)
  process.exit(1)
})
