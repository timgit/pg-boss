/**
 * A registry of pg-boss instances for the Instances pages: a deployment of named workers on
 * Kubernetes-style hosts, with a run in every state and one of everything Pro's instance checks
 * look for. `init-dev-db.ts` writes it after seeding; on its own this script keeps it current.
 *
 *   npm run dev:instances
 *
 * The rows are inserted directly, like the seeded warnings, since a real fleet cannot be made to
 * crash, drift or run out of memory on demand. Their ids all start `5eed`, so this script finds
 * its own rows and leaves real ones alone, and their hosts are made up, so no real instance's
 * crash count or pruning reaches them.
 *
 * A row written once is true only for a moment: within three heartbeats every live run reads as
 * quiet. So while this script runs it moves every timestamp on its rows forward with the clock,
 * every few seconds, which keeps the fleet at the age it was seeded: live runs stay live, the
 * quiet one stays quiet for the same few minutes, and the restart loop stays inside its hour. It
 * also writes the fleet when the schema has none, as after a reseed. Without it running, the
 * rows age like any others.
 *
 * What the fleet shows:
 *
 * - `scheduler` supervises and schedules, and has an earlier run on the same host that stopped.
 * - `api` x2 and `email-worker` x2: healthy runs sharing a name across hosts.
 * - `billing-worker` has callers waiting on its pool, and works `payments`, where nothing is fetchable.
 * - `report-worker` blocks its event loop.
 * - `export-worker` is throttled at its CPU quota, holding the `data-exports` jobs the seed left active.
 * - `import-worker` runs an older pg-boss and is near its memory limit.
 * - `ops-worker` supervises too, on a different monitor interval and warning retention than
 *   `scheduler`.
 * - `flaky-worker` has crashed four times in the last hour, each life with a full heap.
 * - `search-indexer` went quiet while working `search-sync`, which now has nobody on it.
 * - the previous deploy's `api` and `email-worker` pods, stopped, on the older version.
 * - an unnamed run from a laptop, stopped.
 * - `commerce-worker`, `catalog-worker`, `media-worker` and `notify-worker`, two or three replicas
 *   each, working the fleet queues by domain (see DEPLOYMENTS).
 *
 * The workers are what the queue pages show as slots and the Workers card. Only queues the schema
 * has get one, so a smaller fleet (`PGBOSS_SEED_QUEUES`) gets fewer.
 */
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const SEED_PREFIX = '5eed'
const KEEP_CURRENT_SECONDS = 5

const MiB = 1024 ** 2
const GiB = 1024 ** 3
const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

// The checkout's own version for the current deploy, and an older minor for the stragglers.
const VERSION: string = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version
const [major, minor] = VERSION.split('.').map(Number)
const OLD_VERSION = `${major}.${Math.max(0, minor - 2)}.1`

/** The options a default instance records, as the registrar's allowlist picks them. */
const BASE_CONFIG = {
  adapter: 'pg',
  backend: 'postgres',
  createSchema: true,
  useListenNotify: false,
  instanceHeartbeatSeconds: 30,
  superviseIntervalSeconds: 60,
  maintenanceIntervalSeconds: 86400,
  monitorIntervalSeconds: 60,
  queueCacheIntervalSeconds: 60,
  bamIntervalSeconds: 60,
  flowIntervalSeconds: 5,
  reindex: true,
  reindexIntervalSeconds: 86400,
  clockMonitorIntervalSeconds: 600,
  cronMonitorIntervalSeconds: 30,
  cronWorkerIntervalSeconds: 5,
  warningRetentionDays: 365,
  queueStatRetentionDays: 7,
}

interface Metrics {
  cgroup: 1 | 2 | null
  cpu: number | null
  cpuLimit: number
  cpuThrottled: number | null
  rss: number | null
  heapUsed: number | null
  heapLimit: number | null
  memoryUsed: number | null
  memoryLimit: number
  loopDelay: number | null
  loopDelayMax: number | null
  loopUtilization: number | null
}

/** A container with a 1 core quota and 1 GiB, lightly loaded, unless overridden. */
function metrics (overrides: Partial<Metrics> = {}): Metrics {
  const m: Metrics = {
    cgroup: 2,
    cpu: 0.06,
    cpuLimit: 1,
    cpuThrottled: 0,
    rss: 182 * MiB,
    heapUsed: 64 * MiB,
    heapLimit: 512 * MiB,
    memoryUsed: 214 * MiB,
    memoryLimit: GiB,
    loopDelay: 3.1,
    loopDelayMax: 14.2,
    loopUtilization: 0.04,
    ...overrides,
  }
  for (const key of ['rss', 'heapUsed', 'heapLimit', 'memoryUsed', 'memoryLimit'] as const) {
    const bytes = m[key]
    if (bytes !== null) Object.assign(m, { [key]: Math.round(bytes) })
  }
  return m
}

interface Worker {
  queue: string
  localConcurrency: number
  active: number
  batchSize?: number
  pollingIntervalSeconds?: number
  options?: Record<string, unknown>
  /** How long before the run's last heartbeat each of these happened, or null for never. */
  fetched?: number | null
  ended?: number | null
  errored?: number | null
}

interface Run {
  name: string | null
  host: string
  pid?: number
  version?: string
  nodeVersion?: string
  /** How long before the seed it started, and its last heartbeat. */
  started: number
  beat: number
  /** How long before the seed `stop()` was called; absent for a run that is live or crashed. */
  stopped?: number
  supervise?: boolean
  schedule?: boolean
  migrate?: boolean
  pool?: [max: number, total: number, idle: number, waiting: number]
  workers?: Worker[]
  metrics?: Metrics | null
  config?: Record<string, unknown>
  crashRestarts?: number
  /** How long before the seed the first counted crash happened. */
  crashRestartsSince?: number
}

const SUPERVISOR = { supervise: true, migrate: true, config: { persistQueueStats: true, persistWarnings: true } }

// flaky-worker's lives: each lasted about nine minutes and was restarted in the same pod, pid 1
// every time, until the current one. The registrar counts a life once it has gone quiet.
const FLAKY_HOST = 'flaky-worker-6d7f8c9b5-c5hlx'
const FLAKY_LIVES = [41, 32, 23, 14].map((startedMinutes, k): Run => ({
  name: 'flaky-worker',
  host: FLAKY_HOST,
  pid: 1,
  started: startedMinutes * M,
  beat: (startedMinutes - 8.5) * M,
  workers: [{ queue: 'webhook-delivery', localConcurrency: 4, active: 4, fetched: 2 * S, ended: 9 * S }],
  metrics: metrics({ heapUsed: (470 + k * 6) * MiB, rss: 690 * MiB, memoryUsed: 720 * MiB, loopDelay: 48, loopDelayMax: 410, loopUtilization: 0.62 }),
  crashRestarts: k,
  crashRestartsSince: k === 0 ? undefined : 32.5 * M,
}))

const NAMED: Run[] = [
  {
    name: 'scheduler',
    host: 'pgboss-scheduler-5f7d8c9b6-q8x2m',
    started: 2 * D + 4 * H,
    beat: 1 * S,
    schedule: true,
    ...SUPERVISOR,
    pool: [10, 2, 2, 0],
    metrics: metrics({ cpu: 0.03, cpuLimit: 0.5, rss: 142 * MiB, heapUsed: 38 * MiB, heapLimit: 256 * MiB, memoryUsed: 168 * MiB, memoryLimit: 512 * MiB, loopDelay: 2.4, loopDelayMax: 9.8, loopUtilization: 0.02 })
  },
  {
    name: 'scheduler',
    host: 'pgboss-scheduler-5f7d8c9b6-q8x2m',
    started: 6 * D + 2 * H,
    beat: 2 * D + 4 * H + 12 * S,
    stopped: 2 * D + 4 * H + 10 * S,
    schedule: true,
    ...SUPERVISOR,
    pool: [10, 2, 1, 0],
    metrics: metrics({ cpu: 0.03, cpuLimit: 0.5, heapLimit: 256 * MiB, memoryLimit: 512 * MiB })
  },

  {
    name: 'api',
    host: 'api-6b9f7d5c8-k2v9t',
    started: 19 * H + 12 * M,
    beat: 8 * S,
    pool: [10, 3, 2, 0],
    metrics: metrics({ cpu: 0.21, cpuThrottled: 0.02, rss: 268 * MiB, heapUsed: 112 * MiB, memoryUsed: 290 * MiB, loopUtilization: 0.18 })
  },
  {
    name: 'api',
    host: 'api-6b9f7d5c8-zp4lw',
    started: 19 * H + 10 * M,
    beat: 21 * S,
    pool: [10, 4, 3, 0],
    metrics: metrics({ cpu: 0.18, cpuThrottled: 0.01, rss: 251 * MiB, heapUsed: 104 * MiB, memoryUsed: 276 * MiB, loopUtilization: 0.15 })
  },

  {
    name: 'email-worker',
    host: 'email-worker-7c4b9d6f5-hx8rn',
    started: 19 * H + 6 * M,
    beat: 4 * S,
    pool: [10, 5, 1, 0],
    workers: [{ queue: 'email-notifications', localConcurrency: 8, active: 5, fetched: 1 * S, ended: 2 * S, errored: 14 * M }],
    metrics: metrics({ cpu: 0.34, cpuThrottled: 0.04, heapUsed: 96 * MiB, memoryUsed: 246 * MiB, loopDelay: 6.8, loopDelayMax: 31, loopUtilization: 0.27 })
  },
  {
    name: 'email-worker',
    host: 'email-worker-7c4b9d6f5-m3tq7',
    started: 19 * H + 5 * M,
    beat: 17 * S,
    pool: [10, 4, 2, 0],
    workers: [{ queue: 'email-notifications', localConcurrency: 8, active: 3, fetched: 3 * S, ended: 3 * S }],
    metrics: metrics({ cpu: 0.29, cpuThrottled: 0.03, heapUsed: 91 * MiB, memoryUsed: 238 * MiB, loopDelay: 5.9, loopDelayMax: 27, loopUtilization: 0.22 })
  },

  {
    name: 'billing-worker',
    host: 'billing-worker-5d8c7b9f4-wq2zj',
    started: 19 * H + 3 * M,
    beat: 11 * S,
    pool: [4, 4, 0, 3],
    config: { max: 4 },
    workers: [
      { queue: 'payment-processing', localConcurrency: 12, active: 4, fetched: 6 * S, ended: 7 * S, errored: 3 * M },
      // Nothing in payments is fetchable yet: its jobs start later, retry later or wait on billing.
      { queue: 'payments', localConcurrency: 4, active: 0, fetched: 2 * S, ended: 47 * M, errored: 52 * M },
    ],
    metrics: metrics({ cpu: 0.12, heapUsed: 88 * MiB, memoryUsed: 231 * MiB })
  },

  {
    name: 'report-worker',
    host: 'report-worker-84f6c9d7b-tn5kx',
    started: 7 * H + 40 * M,
    beat: 26 * S,
    pool: [10, 3, 1, 0],
    workers: [
      { queue: 'report-generation', localConcurrency: 2, active: 2, fetched: 40 * S, ended: 44 * S },
      { queue: 'user-sync', localConcurrency: 4, active: 1, fetched: 12 * S, ended: 13 * S, options: { includeMetadata: true } },
    ],
    metrics: metrics({ cpu: 0.88, cpuThrottled: 0.09, heapUsed: 212 * MiB, rss: 340 * MiB, memoryUsed: 372 * MiB, loopDelay: 340, loopDelayMax: 2840, loopUtilization: 0.86 })
  },

  {
    name: 'export-worker',
    host: 'export-worker-6c9d8f7b5-r7mzx',
    started: 5 * H + 18 * M,
    beat: 14 * S,
    pool: [10, 4, 1, 0],
    workers: [{ queue: 'data-exports', localConcurrency: 3, active: 3, fetched: 4 * M, ended: 4 * M + 30 * S, errored: 4 * M + 31 * S }],
    metrics: metrics({ cpu: 0.97, cpuThrottled: 0.41, heapUsed: 184 * MiB, rss: 402 * MiB, memoryUsed: 455 * MiB, loopDelay: 38, loopDelayMax: 240, loopUtilization: 0.71 })
  },

  {
    name: 'import-worker',
    host: 'import-worker-7b5c9d8f6-j4kpw',
    version: OLD_VERSION,
    nodeVersion: 'v22.20.0',
    started: 3 * D + 1 * H,
    beat: 9 * S,
    pool: [10, 3, 2, 0],
    workers: [
      { queue: 'data-imports', localConcurrency: 2, active: 0, fetched: 18 * S, ended: 26 * M, errored: 26 * M },
      { queue: 'webhook-delivery', localConcurrency: 4, active: 1, batchSize: 5, pollingIntervalSeconds: 5, fetched: 5 * S, ended: 6 * S },
    ],
    metrics: metrics({ cpu: 0.31, cpuLimit: 2, memoryLimit: 2 * GiB, rss: 1.62 * GiB, heapUsed: 702 * MiB, heapLimit: 1 * GiB, memoryUsed: 1.81 * GiB, loopDelay: 12, loopDelayMax: 96, loopUtilization: 0.3 })
  },

  {
    name: 'ops-worker',
    host: 'ops-worker-5f9c7d6b8-v2nqs',
    started: 19 * H + 1 * M,
    beat: 6 * S,
    pool: [10, 3, 2, 0],
    ...SUPERVISOR,
    config: { persistQueueStats: true, persistWarnings: true, monitorIntervalSeconds: 30, warningRetentionDays: 30 },
    workers: [
      { queue: 'cleanup-tasks', localConcurrency: 1, active: 0, fetched: 2 * S, ended: 11 * M },
      { queue: 'tenant-jobs', localConcurrency: 2, active: 1, fetched: 7 * S, ended: 9 * S, options: { groupConcurrency: 1 } },
      { queue: 'dead-letters', localConcurrency: 1, active: 0, fetched: 4 * S, ended: 2 * H },
    ],
    metrics: metrics({ cpu: 0.09, heapUsed: 72 * MiB, memoryUsed: 221 * MiB })
  },

  ...FLAKY_LIVES,
  {
    name: 'flaky-worker',
    host: FLAKY_HOST,
    pid: 1,
    started: 5 * M,
    beat: 19 * S,
    pool: [10, 3, 0, 0],
    workers: [{ queue: 'webhook-delivery', localConcurrency: 4, active: 4, fetched: 3 * S, ended: 8 * S }],
    metrics: metrics({ heapUsed: 301 * MiB, rss: 498 * MiB, memoryUsed: 530 * MiB, loopDelay: 21, loopDelayMax: 180, loopUtilization: 0.48 }),
    crashRestarts: FLAKY_LIVES.length,
    crashRestartsSince: 32.5 * M
  },

  {
    name: 'search-indexer',
    host: 'search-indexer-7f6b8d9c5-w9ftz',
    started: 3 * H + 12 * M,
    beat: 7 * M + 20 * S,
    pool: [10, 4, 0, 0],
    workers: [{ queue: 'search-sync', localConcurrency: 4, active: 4, fetched: 52 * S, ended: 58 * S }],
    metrics: metrics({ cpu: 0.64, heapUsed: 233 * MiB, memoryUsed: 410 * MiB, loopDelay: 85, loopDelayMax: 620, loopUtilization: 0.74 })
  },

  // The previous deploy, rolled 19 hours ago.
  {
    name: 'api',
    host: 'api-58c7d9f6b-xq7lp',
    version: OLD_VERSION,
    nodeVersion: 'v22.20.0',
    started: 3 * D + 2 * H,
    beat: 19 * H + 11 * M,
    stopped: 19 * H + 11 * M,
    pool: [10, 3, 3, 0],
    metrics: metrics({ cpu: 0.19, heapUsed: 101 * MiB, memoryUsed: 281 * MiB })
  },
  {
    name: 'email-worker',
    host: 'email-worker-6f8b5c7d9-pl2ve',
    version: OLD_VERSION,
    nodeVersion: 'v22.20.0',
    started: 3 * D + 2 * H,
    beat: 19 * H + 5 * M,
    stopped: 19 * H + 5 * M,
    pool: [10, 2, 2, 0],
    workers: [{ queue: 'email-notifications', localConcurrency: 8, active: 0, fetched: 1 * S, ended: 1 * S }],
    metrics: metrics({ cpu: 0.27, heapUsed: 94 * MiB, memoryUsed: 240 * MiB })
  },

  // Someone running the app locally against this database, with every default.
  {
    name: null,
    host: 'dev-laptop.local',
    pid: 48213,
    nodeVersion: 'v24.11.0',
    started: 3 * H + 40 * M,
    beat: 3 * H + 15 * M,
    stopped: 3 * H + 15 * M,
    supervise: true,
    schedule: true,
    migrate: true,
    pool: [10, 2, 2, 0],
    metrics: metrics({ cgroup: null, cpu: 0.02, cpuLimit: 10, cpuThrottled: null, memoryUsed: null, memoryLimit: 32 * GiB, heapLimit: 4.2 * GiB })
  },
]

/**
 * The deployment working the seed's fleet queues (`orders-sync`, `media-resize` and so on), by
 * domain: each replica runs one `work()` per queue of its domains that the schema has. Some stay
 * unworked on purpose: the flow parents and children the seed keeps blocked, the two queues its
 * stats show stalled, and `search-sync`, whose worker went quiet. The queues its stats show behind
 * get every slot busy, so a shortage of workers is what they show.
 */
const DEPLOYMENTS: Array<{ name: string, pod: string, replicas: string[], domains: string[], started: number }> = [
  { name: 'commerce-worker', pod: '7d9f6c8b5', replicas: ['b4kxz', 'n8wqd', 'r2mtj'], domains: ['orders', 'invoices', 'shipments', 'ledger'], started: 19 * H + 2 * M },
  { name: 'catalog-worker', pod: '5c8d7f9b6', replicas: ['h6vpl', 'x3gzn'], domains: ['inventory', 'catalog', 'search'], started: 19 * H },
  { name: 'media-worker', pod: '6f7b9c5d8', replicas: ['k9tqw', 'p5rmz'], domains: ['media', 'analytics'], started: 11 * H + 25 * M },
  { name: 'notify-worker', pod: '8b6d5f7c9', replicas: ['d7jxs', 'w2lkq'], domains: ['alerts', 'accounts', 'support'], started: 19 * H + 4 * M },
]

const UNWORKED = new Set(['billing', 'orders-sync', 'invoices-sync', 'shipments-sync', 'ledger-reindex', 'media-ingest', 'search-sync'])
const SATURATED = new Set(['orders-export', 'alerts-notify'])

/** Concurrency and batch size by the task half of a fleet queue's name. */
const TASK_SHAPE: Record<string, [localConcurrency: number, batchSize: number]> = {
  sync: [4, 1],
  ingest: [4, 1],
  export: [2, 1],
  reindex: [1, 1],
  notify: [8, 1],
  reconcile: [1, 1],
  resize: [2, 1],
  score: [2, 1],
  archive: [1, 1],
  enrich: [2, 10],
}

function deployments (queues: Set<string>): Run[] {
  return DEPLOYMENTS.flatMap((deployment, d) => deployment.replicas.map((replica, r): Run => {
    const worked = [...queues].sort()
      .filter((queue) => deployment.domains.some((domain) => queue.startsWith(`${domain}-`)) && !UNWORKED.has(queue))
    const workers = worked.map((queue, n): Worker => {
      const [localConcurrency, batchSize] = TASK_SHAPE[queue.slice(queue.indexOf('-') + 1)] ?? [2, 1]
      const slots = localConcurrency * batchSize
      return {
        queue,
        localConcurrency,
        batchSize,
        active: SATURATED.has(queue) ? slots : (n * 7 + r * 3 + d) % (slots + 1),
        fetched: ((n + r) % 5 + 1) * S,
        ended: ((n * 3 + r) % 9 + 1) * S,
        errored: (n + d + r) % 6 === 0 ? ((n % 4) * 17 + 3) * M : null,
      }
    })
    const busy = workers.reduce((sum, w) => sum + w.active, 0)
    return {
      name: deployment.name,
      host: `${deployment.name}-${deployment.pod}-${replica}`,
      started: deployment.started - r * 40 * S,
      beat: ((d * 3 + r * 7) % 25 + 2) * S,
      pool: [10, Math.min(10, 2 + Math.ceil(busy / 3)), 1 + r, 0],
      workers,
      metrics: metrics({
        cpu: Math.min(0.9, 0.08 + busy * 0.03),
        cpuThrottled: 0.01 * r,
        heapUsed: (90 + busy * 4 + r * 11) * MiB,
        rss: (220 + busy * 6) * MiB,
        memoryUsed: (250 + busy * 7 + r * 13) * MiB,
        loopDelay: 4 + busy * 0.4,
        loopDelayMax: 20 + busy * 3,
        loopUtilization: Math.min(0.8, 0.05 + busy * 0.02),
      }),
    }
  }))
}

/** The named runs, then the deployment, each worker kept only when the schema has its queue. */
function fleet (queues: Set<string>): Run[] {
  return [...NAMED, ...deployments(queues)]
    .map((run) => ({ ...run, workers: run.workers?.filter((w) => queues.has(w.queue)) }))
}

const iso = (at: number | null | undefined, from: number) => (at === null || at === undefined ? null : new Date(from - at).toISOString())

function seedId (k: number): string {
  return `${SEED_PREFIX}0000-0000-4000-8000-${String(k + 1).padStart(12, '0')}`
}

/** Writes the fleet, its ages counted back from the database's clock; rows already there are kept. */
export async function seedInstances (client: Client, schema: string): Promise<number> {
  const { rows: [{ now }] } = await client.query<{ now: Date }>(`SELECT ${schema}.job_now() AS now`)
  const seededAt = new Date(now).getTime()
  const at = (ago: number | undefined) => (ago === undefined ? null : new Date(seededAt - ago))
  const { rows: queueRows } = await client.query<{ name: string }>(`SELECT name FROM ${schema}.queue`)
  let written = 0

  for (const [k, run] of fleet(new Set(queueRows.map((q) => q.name))).entries()) {
    const id = seedId(k)
    const beatOn = seededAt - run.beat
    const supervise = run.supervise ?? false
    const schedule = run.schedule ?? false
    const migrate = run.migrate ?? false
    const config: Record<string, unknown> = { ...BASE_CONFIG, supervise, schedule, migrate, ...run.config }
    const [poolMax, poolTotal, poolIdle, poolWaiting] = run.pool ?? [10, 1, 1, 0]
    const workers = (run.workers ?? []).map((w, n) => ({
      id: `${SEED_PREFIX}0001-0000-4000-8000-${String(k * 100 + n + 1).padStart(12, '0')}`,
      queue: w.queue,
      localConcurrency: w.localConcurrency,
      batchSize: w.batchSize ?? 1,
      pollingIntervalSeconds: w.pollingIntervalSeconds ?? 2,
      active: w.active,
      lastFetchedOn: iso(w.fetched, beatOn),
      lastJobEndedOn: iso(w.ended, beatOn),
      lastErrorOn: iso(w.errored, beatOn),
      options: w.options ?? {},
    }))

    const { rowCount } = await client.query(
      `INSERT INTO ${schema}.instance (
         id, name, host, pid, version, node_version, application_name, heartbeat_seconds,
         supervise, schedule, migrate, persist_queue_stats, persist_warnings,
         pool_max, pool_total, pool_idle, pool_waiting, workers, metrics, config,
         crash_restarts, crash_restarts_since, started_on, heartbeat_on, stopped_on
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 30, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
       ON CONFLICT (id) DO NOTHING`,
      [
        id, run.name, run.host, run.pid ?? 1, run.version ?? VERSION, run.nodeVersion ?? 'v24.11.0', `pgboss:${id.slice(0, 8)}`,
        supervise, schedule, migrate, config.persistQueueStats === true, config.persistWarnings === true,
        poolMax, poolTotal, poolIdle, poolWaiting,
        JSON.stringify(workers), run.metrics === null ? null : JSON.stringify(run.metrics ?? metrics()), JSON.stringify(config),
        run.crashRestarts ?? 0, at(run.crashRestartsSince), at(run.started), new Date(beatOn), at(run.stopped),
      ]
    )
    written += rowCount ?? 0
  }

  return written
}

/**
 * Moves every seeded timestamp forward by however long it has been since the freshest seeded
 * heartbeat, the workers' times with them, so the fleet reads exactly as old as when it was seeded.
 */
export async function keepInstancesCurrent (client: Client, schema: string): Promise<void> {
  await client.query(`
    WITH shift AS (
      SELECT ${schema}.job_now() - max(heartbeat_on) AS by
        FROM ${schema}.instance
       WHERE id::text LIKE '${SEED_PREFIX}%' AND stopped_on IS NULL
    )
    UPDATE ${schema}.instance i SET
      started_on = started_on + shift.by,
      heartbeat_on = heartbeat_on + shift.by,
      stopped_on = stopped_on + shift.by,
      crash_restarts_since = crash_restarts_since + shift.by,
      workers = (
        SELECT coalesce(jsonb_agg(w.value || (
                 SELECT coalesce(jsonb_object_agg(key, to_jsonb((w.value->>key)::timestamptz + shift.by)), '{}'::jsonb)
                   FROM unnest(array['lastFetchedOn', 'lastJobEndedOn', 'lastErrorOn']) AS key
                  WHERE w.value->>key IS NOT NULL
               ) ORDER BY w.n), '[]'::jsonb)
          FROM jsonb_array_elements(i.workers) WITH ORDINALITY AS w(value, n)
      )
      FROM shift
     WHERE i.id::text LIKE '${SEED_PREFIX}%' AND shift.by > interval '0'
  `)
}

async function main () {
  const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/pgboss'
  const schema = process.env.PGBOSS_SCHEMA || 'pgboss_dev'

  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`Refusing schema "${schema}": not a bare SQL identifier.`)
  }

  const client = new Client({ connectionString })
  await client.connect()
  console.log(`Keeping the seeded instances in "${schema}" current; Ctrl-C to stop.`)

  const stop = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => stop.abort())
  }

  try {
    while (!stop.signal.aborted) {
      // The schema comes and goes under a reseed, so each pass checks for it.
      const { rows: [{ exists }] } = await client.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [`${schema}.instance`])

      if (exists) {
        const { rows: [{ seeded }] } = await client.query<{ seeded: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${schema}.instance WHERE id::text LIKE '${SEED_PREFIX}%') AS seeded`
        )

        if (!seeded) {
          console.log(`  instances: ${await seedInstances(client, schema)} written`)
        }

        await keepInstancesCurrent(client, schema)
      }

      await sleep(KEEP_CURRENT_SECONDS * 1000, undefined, { signal: stop.signal }).catch(() => {})
    }
  } finally {
    await client.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Failed to keep instances current:', err.message)
    process.exit(1)
  })
}
