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
 * - A fleet of further queues (60 by default, `PGBOSS_SEED_QUEUES` to change it)
 *   with a few ready jobs each and nothing working them, so lists, cards and the
 *   honeycomb can be seen at a realistic size.
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
  // Without this the monitor never writes `queue_stats`, the metrics chart has
  // nothing to draw, and every queue shows the "stats history isn't being
  // recorded" banner — which is accurate but makes the whole surface
  // unreviewable in dev. `queueStatRetentionDays` defaults to 7.
  persistQueueStats: true,
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
  await seedFleetQueues()
  await seedSchedules()

  // Let the supervisor move the dead-lettered jobs and the monitor refresh the
  // per-queue counters the queue list reads.
  console.log('  waiting for supervisor and monitor...')
  await sleep(4000)
  await boss.stop()

  await seedWarnings()
  await seedAsyncMigrations()
  await seedReadyHistory()
  await seedQueueStats()

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

const FLEET_DOMAINS = ['orders', 'invoices', 'shipments', 'inventory', 'accounts', 'search', 'media', 'alerts', 'analytics', 'ledger', 'catalog', 'support']
const FLEET_TASKS = ['sync', 'ingest', 'export', 'reindex', 'notify', 'reconcile', 'resize', 'score', 'archive', 'enrich']

/**
 * A fleet of queues beyond the handful above, so the queue views can be judged at a size closer to a
 * real deployment's. Named domain-task, each with a few ready jobs (none for some) and nobody working
 * them, so their backlogs stay put. Their stats history comes from `seedQueueStats`, like every queue's.
 */
/** Fleet queues whose last hour of stats shows them in trouble, so health has every colour to draw. */
const TROUBLE: Record<string, 'stalled' | 'behind'> = {
  'ledger-reindex': 'stalled',
  'media-ingest': 'stalled',
  'orders-export': 'behind',
  'search-sync': 'behind',
  'alerts-notify': 'behind',
}

function troubleOf (name: string): 'stalled' | 'behind' | null {
  return TROUBLE[name] ?? null
}

async function seedFleetQueues () {
  const count = Math.max(0, Number(process.env.PGBOSS_SEED_QUEUES ?? 60))
  const names = FLEET_TASKS.flatMap((task) => FLEET_DOMAINS.map((domain) => `${domain}-${task}`)).slice(0, count)

  for (const [k, name] of names.entries()) {
    await boss.createQueue(name, { policy: 'standard' })
    // A real backlog behind the queues `seedQueueStats` makes stall or fall behind.
    const ready = troubleOf(name) === 'stalled' ? 140 : troubleOf(name) === 'behind' ? 70 : (k * 7) % 9
    if (ready > 0) {
      await boss.insert(name, Array.from({ length: ready }, (_, i) => ({ data: { seq: i } })))
    }
  }

  console.log(`  fleet queues: ${names.length}`)
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

/**
 * Recent background async migrations, one in each status, so /migrations has rows to show: index
 * builds pg-boss queued for its current schema version and the one before, one finished, one
 * running, one waiting and one that failed on a lock timeout.
 */
async function seedAsyncMigrations () {
  const client = new Client({ connectionString })
  await client.connect()

  try {
    const { rows: [{ version }] } = await client.query<{ version: number }>(`SELECT version FROM ${schema}.version`)
    const index = (name: string, on: string) => `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${schema}.job_common ${on}`
    const rows: Array<[string, number, string, string | null, string, string | null, string, string | null, string | null]> = [
      // name, version, status, queue, command, error, created ago, started ago, completed ago
      ['job_i7', version - 1, 'completed', null, index('job_i7', "(name, group_id) WHERE state = 'active' AND group_id IS NOT NULL"), null, '3 hours', '3 hours', '2 hours 52 minutes'],
      ['job_i8', version, 'completed', 'demo-exports', index('job_i8', '(name, singleton_on) WHERE singleton_on IS NOT NULL'), null, '40 minutes', '38 minutes', '35 minutes'],
      ['job_i8', version, 'in_progress', 'demo-payments', index('job_i8', '(name, singleton_on) WHERE singleton_on IS NOT NULL'), null, '40 minutes', '4 minutes', null],
      ['job_i8', version, 'pending', 'demo-webhooks', index('job_i8', '(name, singleton_on) WHERE singleton_on IS NOT NULL'), null, '40 minutes', null, null],
      ['job_i6', version - 1, 'failed', 'demo-imports', index('job_i6', '(name, keep_until) WHERE state >= \'completed\''), 'canceling statement due to lock timeout', '1 day', '1 day', null],
    ]

    for (const [name, v, status, queue, command, error, created, started, completed] of rows) {
      await client.query(
        `INSERT INTO ${schema}.bam (name, version, status, queue, table_name, command, error, created_on, started_on, completed_on)
         VALUES ($1, $2, $3, $4, 'job_common', $5, $6, now() - $7::interval,
                 now() - $8::interval, now() - $9::interval)`,
        [name, v, status, queue, command, error, created, started, completed]
      )
    }
    console.log(`  async migrations: ${rows.length}`)
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

// Mirrors LATENCY_SLOTS and LATENCY_MIN_SECONDS in src/plans.ts: slot 0 is under 10 ms, each slot
// after it √2 wider, and the last slot everything past about 23 hours.
const LATENCY_SLOTS = 48
const LATENCY_MIN_SECONDS = 0.01

function latencySlot (seconds: number): number {
  if (seconds < LATENCY_MIN_SECONDS) return 0
  const k = Math.floor(Math.log(seconds / LATENCY_MIN_SECONDS) / (Math.log(2) / 2)) + 1
  return Math.min(LATENCY_SLOTS - 1, k)
}

/**
 * Spread `count` jobs over the slots around `seconds`, as a Postgres array literal with nulls
 * where no job landed, which is how the monitor stores them. A small tail two slots above the
 * centre gives the p95 and p99 somewhere to be. Null when nothing finished, as the monitor writes
 * an all-null histogram rather than none.
 */
function binsLiteral (count: number, seconds: number): string {
  const slots: Array<number | null> = new Array(LATENCY_SLOTS).fill(null)

  if (count > 0) {
    const centre = latencySlot(seconds)
    const weights = [[-2, 0.06], [-1, 0.24], [0, 0.4], [1, 0.2], [2, 0.07], [4, 0.03]] as const
    let placed = 0

    for (const [offset, weight] of weights) {
      const slot = Math.max(0, Math.min(LATENCY_SLOTS - 1, centre + offset))
      const n = Math.floor(count * weight)
      if (n > 0) slots[slot] = (slots[slot] ?? 0) + n
      placed += n
    }

    // Rounding leftovers go to the centre, so the slots add up to the jobs counted.
    if (placed < count) slots[centre] = (slots[centre] ?? 0) + count - placed
  }

  return `{${slots.map((n) => n ?? 'NULL').join(',')}}`
}

/**
 * Throughput, latency and oldest-ready-wait series to go beside the counts in `seedQueueStats`.
 *
 * The throughput rides the same daily wave as the counts, a little ahead of it, so arrivals peak
 * before the backlog does. Wait times follow the ready count over the drain rate, which is what a
 * backlog does to them, and each queue keeps its own typical run time. Every ninth queue by hash
 * fails noticeably, so the failure series is not zero everywhere.
 */
function sampleThroughput (h: number, ready: number[], perDay: number, phase: number, windowSeconds: number) {
  const perMinute = 5 + (h % 40)
  const failRate = h % 9 === 0 ? 0.08 : 0.005 + (h % 5) * 0.002
  const runSeconds = 0.05 * Math.SQRT2 ** (h % 14)

  const out = {
    created: [] as number[],
    completed: [] as number[],
    failed: [] as number[],
    readyOldest: [] as number[],
    waitBins: [] as string[],
    runBins: [] as string[],
  }

  for (let i = 0; i < ready.length; i++) {
    const wave = 0.5 + 0.5 * Math.sin((i / perDay) * 2 * Math.PI + phase + 0.4)
    const finished = Math.round(perMinute * (windowSeconds / 60) * (0.3 + 0.9 * wave))
    const failed = Math.round(finished * failRate)
    // Arrivals outrun the drain while the backlog builds and trail it while it empties.
    const backlogChange = i === 0 ? 0 : ready[i] - ready[i - 1]
    const created = Math.max(0, finished + backlogChange * 3 + ((i * 11 + h) % 7) - 3)
    const drainPerSecond = Math.max(finished / windowSeconds, 0.01)
    const waitSeconds = Math.max(0.02, ready[i] / drainPerSecond / 4)

    out.created.push(created)
    out.completed.push(finished - failed)
    out.failed.push(failed)
    out.readyOldest.push(ready[i] === 0 ? 0 : Math.round(waitSeconds * 2.5))
    out.waitBins.push(binsLiteral(finished, waitSeconds))
    out.runBins.push(binsLiteral(finished, runSeconds))
  }

  return out
}

/**
 * Backfill `queue_stats` so the metrics chart has a range to draw.
 *
 * pg-boss writes one row per queue per monitor cycle, but only when constructed
 * with `persistQueueStats: true` — which this script now does. That alone still
 * leaves a fresh database holding a few seconds of history while the metrics
 * page defaults to a 24-hour range, so every range but the shortest would draw
 * empty. And `getQueueStatsCollectionStatus` only asks whether the table has any
 * row at all, so an unseeded database shows the "stats history isn't being
 * recorded" banner even once recording is on.
 *
 * `queue_stats` is partitioned by UTC day and pg-boss maintains only today's and
 * tomorrow's partitions (`ensureQueueStatsPartitions` in src/plans.ts), so the
 * backfill creates the older ones itself. It repeats that function's naming and
 * its explicit `+00` bounds deliberately: a bare date literal would be cast in
 * the session time zone, and rows written near UTC midnight would fall outside
 * every partition.
 *
 * DAYS stays below the 7-day `queueStatRetentionDays` default so the first
 * maintenance pass — which runs as soon as `npm run dev:worker` starts — does not
 * drop the partitions this just created.
 *
 * Each series is blended into the queue's real current counts, exactly as the
 * ready sparkline is, so the right edge of the chart agrees with the numbers
 * rendered on the queue detail page beside it. Every row also carries the
 * throughput deltas, wait and run histograms and oldest ready wait that a
 * counted monitor pass writes (see `sampleThroughput`), so the throughput and
 * latency views have the same six days to draw.
 */
async function seedQueueStats () {
  const DAYS = 6
  const INTERVAL_MINUTES = 10
  const SAMPLES = (DAYS * 24 * 60) / INTERVAL_MINUTES
  const PER_DAY = (24 * 60) / INTERVAL_MINUTES

  const client = new Client({ connectionString })
  await client.connect()

  try {
    await client.query(`
      DO $$
      DECLARE
        d date;
        i int;
        part_name text;
      BEGIN
        FOR i IN -${DAYS}..1 LOOP
          d := (${schema}.job_now() AT TIME ZONE 'UTC')::date + i;
          part_name := 'queue_stats_' || to_char(d, 'YYYYMMDD');
          IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = '${schema}' AND c.relname = part_name
          ) THEN
            EXECUTE format(
              'CREATE TABLE ${schema}.%I PARTITION OF ${schema}.queue_stats FOR VALUES FROM (%L) TO (%L)',
              part_name,
              to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
              to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
            );
          END IF;
        END LOOP;
      END;
      $$
    `)

    const { rows: queues } = await client.query<{
      name: string
      ready_count: number
      active_count: number
      failed_count: number
      queued_count: number
      deferred_count: number
      total_count: number
    }>(
      `SELECT name, ready_count, active_count, failed_count, queued_count, deferred_count, total_count
         FROM ${schema}.queue ORDER BY name`
    )

    // A per-name hash gives each queue its own phase and amplitude, so they do
    // not all peak on the same tick and each one draws the same shape on every
    // run.
    const hash = (name: string): number => {
      let h = 0
      for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0
      return Math.abs(h)
    }

    const now = Date.now()
    let rows = 0

    for (const queue of queues) {
      const h = hash(queue.name)
      const p = (h % 360) * (Math.PI / 180)
      // Amplitudes are the series' own, not a multiple of the queue's current
      // counts. Those counts are mostly zero on a seeded database — the demo
      // jobs are pinned in terminal states, which no live counter reflects — so
      // scaling by them would draw the flat line this function exists to avoid.
      const peak = 12 + (h % 48)
      const at: Date[] = []
      const series: Record<string, number[]> = {
        ready: [], active: [], failed: [], queued: [], deferred: [], total: [],
      }

      for (let i = 0; i < SAMPLES; i++) {
        at.push(new Date(now - (SAMPLES - 1 - i) * INTERVAL_MINUTES * 60_000))

        // One cycle per day, so a 24-hour view shows a full wave and the 7-day
        // view shows six of them.
        const wave = 0.5 + 0.5 * Math.sin((i / PER_DAY) * 2 * Math.PI + p)

        // A little per-tick jitter, deterministic in i, so the lines are not
        // suspiciously smooth.
        const jitter = (i * 7 + h) % 5

        series.ready.push(Math.round(peak * wave) + jitter)
        series.active.push(Math.round(peak * 0.25 * wave))
        // Failures accumulate over a window rather than oscillating, so this one
        // ramps instead of waving.
        series.failed.push(Math.round((peak / 6) * (i / SAMPLES)))
        series.queued.push(Math.round(peak * 0.4 * wave) + (jitter % 2))
        series.deferred.push(Math.round(peak * 0.15 * (1 - wave)))
        series.total.push(Math.round(peak * (0.8 + 0.6 * wave)) + jitter)
      }

      const throughput = sampleThroughput(h, series.ready, PER_DAY, p, INTERVAL_MINUTES * 60)

      // Over the last hour a stalled queue finishes nothing and one falling behind finishes half of
      // what arrives, while the blend below walks its ready count up into the backlog it holds.
      const trouble = troubleOf(queue.name)
      if (trouble) {
        for (let i = SAMPLES - 60 / INTERVAL_MINUTES; i < SAMPLES; i++) {
          throughput.created[i] = Math.max(throughput.created[i], 6)
          throughput.completed[i] = trouble === 'stalled' ? 0 : Math.round(throughput.created[i] * 0.5)
          throughput.failed[i] = 0
        }
      }

      const ends: Record<string, number> = {
        ready: Number(queue.ready_count),
        active: Number(queue.active_count),
        failed: Number(queue.failed_count),
        queued: Number(queue.queued_count),
        deferred: Number(queue.deferred_count),
        total: Number(queue.total_count),
      }

      for (const key of Object.keys(series)) {
        series[key] = blendTail(series[key], ends[key], 12)
      }

      // The deltas cover the window up to each sample, so delta_on is the sample's own time.
      // The bins travel as array literals, since unnest flattens a two-dimensional array.
      await client.query(
        `INSERT INTO ${schema}.queue_stats
           (name, captured_on, ready_count, active_count, failed_count, queued_count, deferred_count, total_count,
            created_delta, completed_delta, failed_delta, delta_seconds, delta_on, ready_oldest_seconds,
            wait_bins, run_bins)
         SELECT $1, t, r, a, f, q, d, tot, cd, cpd, fd, $9, t, ros, wb::int[], rb::int[]
           FROM unnest($2::timestamptz[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[],
                       $10::int[], $11::int[], $12::int[], $13::int[], $14::text[], $15::text[])
             AS s(t, r, a, f, q, d, tot, cd, cpd, fd, ros, wb, rb)`,
        [
          queue.name, at, series.ready, series.active, series.failed, series.queued, series.deferred, series.total,
          INTERVAL_MINUTES * 60,
          throughput.created, throughput.completed, throughput.failed, throughput.readyOldest,
          throughput.waitBins, throughput.runBins,
        ]
      )

      rows += SAMPLES
    }

    console.log(`  queue stats: ${queues.length} queues x ${SAMPLES} samples over ${DAYS}d (${rows} rows)`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('Failed to initialize:', err.message)
  process.exit(1)
})
