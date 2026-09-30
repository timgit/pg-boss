import type { Instance } from '~/lib/types'

/** The clock the instance tests judge ages against. */
export const NOW = new Date('2026-09-29T12:00:00Z')

export const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000)

let next = 0

/** A live, unnamed-role instance on `app-01`, started an hour ago; override what a case needs. */
export function instance (overrides: Partial<Instance> = {}): Instance {
  next++
  return {
    id: `${String(next).padStart(8, '0')}-0000-4000-8000-000000000000`,
    name: 'api',
    host: 'app-01',
    pid: 1000 + next,
    version: '12.36.0',
    nodeVersion: 'v22.11.0',
    applicationName: null,
    heartbeatSeconds: 30,
    supervise: false,
    schedule: false,
    migrate: false,
    persistQueueStats: false,
    persistWarnings: false,
    poolMax: 10,
    poolTotal: 2,
    poolIdle: 2,
    poolWaiting: 0,
    workers: [],
    metrics: null,
    config: {},
    crashRestarts: 0,
    crashRestartsSince: null,
    startedOn: secondsAgo(3600),
    heartbeatOn: secondsAgo(10),
    stoppedOn: null,
    live: true,
    ...overrides,
  }
}

/** An instance that crashed: never stopped, and its last heartbeat `s` seconds ago. */
export function quiet (s: number, overrides: Partial<Instance> = {}): Instance {
  return instance({ live: false, heartbeatOn: secondsAgo(s), startedOn: secondsAgo(s + 600), ...overrides })
}

/** An instance stopped gracefully `s` seconds ago. */
export function stopped (s: number, overrides: Partial<Instance> = {}): Instance {
  return instance({ live: false, heartbeatOn: secondsAgo(s), stoppedOn: secondsAgo(s), startedOn: secondsAgo(s + 86400), ...overrides })
}

export const worker = (queue: string) => ({
  id: `w-${queue}`,
  queue,
  localConcurrency: 2,
  batchSize: 1,
  pollingIntervalSeconds: 2,
  active: 0,
  lastFetchedOn: null,
  lastJobEndedOn: null,
  lastErrorOn: null,
})
