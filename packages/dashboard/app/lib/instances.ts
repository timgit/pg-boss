import type { Instance, InstanceWorker } from './types'

/** A quiet instance stays in the default view this long after it went quiet. */
export const QUIET_LISTED_MS = 60 * 60_000

/** What the Recent filter means: started, stopped or gone quiet within this long. */
export const RECENT_MS = 24 * 60 * 60_000

/** Heartbeats an instance may miss before it reads as quiet, as core judges it. */
const QUIET_BEATS = 3

export type InstanceStatus = 'live' | 'quiet' | 'stopped'

/** Which status filter lists a row. Quiet rows older than an hour sit with the stopped ones. */
export type InstanceBucket = InstanceStatus

export interface ListedInstance {
  instance: Instance
  status: InstanceStatus
  bucket: InstanceBucket
  /** Started, stopped or went quiet within `RECENT_MS`. */
  recent: boolean
}

export function instanceStatus (instance: Instance): InstanceStatus {
  if (instance.stoppedOn) return 'stopped'
  return instance.live ? 'live' : 'quiet'
}

/** When a quiet instance went quiet: its last heartbeat plus the beats it was allowed to miss. */
export function quietSince (instance: Instance): Date {
  return new Date(new Date(instance.heartbeatOn).getTime() + instance.heartbeatSeconds * QUIET_BEATS * 1000)
}

const time = (d: Date | string) => new Date(d).getTime()

/** When a row ended: its clean stop, or when it went quiet; null while it is live. */
export function endedOn (instance: Instance): Date | null {
  if (instance.stoppedOn) return new Date(instance.stoppedOn)
  return instance.live ? null : quietSince(instance)
}

/** Every row with its status and the filter that lists it. Each row is one start of one process. */
export function listInstances (instances: Instance[], now: Date): ListedInstance[] {
  return instances.map((instance): ListedInstance => {
    const status = instanceStatus(instance)
    const ended = endedOn(instance)
    const bucket = status === 'quiet' && ended && now.getTime() - ended.getTime() >= QUIET_LISTED_MS ? 'stopped' : status
    const recent = now.getTime() - time(instance.startedOn) < RECENT_MS || (ended !== null && now.getTime() - ended.getTime() < RECENT_MS)
    return { instance, status, bucket, recent }
  })
}

/** By name with unnamed last, then host, then newest first. */
export function byName (a: ListedInstance, b: ListedInstance): number {
  const an = a.instance.name
  const bn = b.instance.name
  if (an !== bn) {
    if (an == null) return 1
    if (bn == null) return -1
    return an.localeCompare(bn)
  }
  return a.instance.host.localeCompare(b.instance.host) || time(b.instance.startedOn) - time(a.instance.startedOn)
}

/** Whether a filter string names this instance: its name, host, id or a queue it works. */
export function matchesInstance (instance: Instance, needle: string): boolean {
  if (!needle) return true
  const n = needle.toLowerCase()
  return (instance.name ?? '').toLowerCase().includes(n) ||
    instance.host.toLowerCase().includes(n) ||
    instance.id.startsWith(n) ||
    instance.workers.some((w) => w.queue.toLowerCase().includes(n))
}

/** The roles an instance took on, in the order the options are documented. */
export function instanceRoles (instance: Instance): string[] {
  return [instance.supervise && 'supervisor', instance.schedule && 'scheduler', instance.migrate && 'migrator'].filter((r): r is string => Boolean(r))
}

/** A span in the largest unit that reads well: "40s", "12m", "3h 5m", "2d". */
export function formatSpan (ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return h < 10 && m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** How long before `now` a time was, as "12s ago". */
export function formatAgo (then: Date | string, now: Date): string {
  return `${formatSpan(now.getTime() - time(then))} ago`
}

/** One queue an instance works, with the `work()` calls on it and their totals. */
export interface QueueWork {
  queue: string
  calls: InstanceWorker[]
  /** Every call's `localConcurrency`, added up. */
  workers: number
  active: number
  lastFetchedOn: string | null
  lastJobEndedOn: string | null
  lastErrorOn: string | null
}

const later = (a: string | null, b: string | null) => (a === null || (b !== null && b > a) ? b : a)

/** An instance's `work()` calls grouped by queue, in name order, each group's times the latest of its calls. */
export function workByQueue (workers: InstanceWorker[]): QueueWork[] {
  const byQueue = new Map<string, QueueWork>()
  for (const w of workers) {
    const group = byQueue.get(w.queue) ?? { queue: w.queue, calls: [], workers: 0, active: 0, lastFetchedOn: null, lastJobEndedOn: null, lastErrorOn: null }
    group.calls.push(w)
    group.workers += w.localConcurrency
    group.active += w.active
    group.lastFetchedOn = later(group.lastFetchedOn, w.lastFetchedOn)
    group.lastJobEndedOn = later(group.lastJobEndedOn, w.lastJobEndedOn)
    group.lastErrorOn = later(group.lastErrorOn, w.lastErrorOn)
    byQueue.set(w.queue, group)
  }
  return [...byQueue.values()].sort((a, b) => a.queue.localeCompare(b.queue))
}

const seconds = (n: number) => `${n}s`
const WORK_OPTION: Record<string, (value: unknown) => string> = {
  heartbeatRefreshSeconds: (v) => seconds(v as number),
  transactionTimeoutSeconds: (v) => seconds(v as number),
  notifyPollingIntervalSeconds: (v) => seconds(v as number),
}

function formatWorkOption (key: string, value: unknown): string {
  if (WORK_OPTION[key]) return WORK_OPTION[key](value)
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (value !== null && typeof value === 'object') {
    // groupConcurrency and localGroupConcurrency: a default, and a limit per tier.
    const { default: base, tiers } = value as { default?: number, tiers?: Record<string, number> }
    return [String(base), ...Object.entries(tiers ?? {}).map(([tier, n]) => `${tier} ${n}`)].join(', ')
  }
  return String(value)
}

/**
 * One `work()` call's settings, as label and value. Batch size and polling always; the rest only
 * when the call set them, which a row from a pg-boss that did not record them never says.
 */
export function workSettings (w: InstanceWorker): Array<[string, string]> {
  return [
    ['batchSize', String(w.batchSize)],
    ['pollingIntervalSeconds', w.pollingIntervalSeconds == null ? 'the default' : seconds(w.pollingIntervalSeconds)],
    ...Object.entries(w.options ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]): [string, string] => [key, formatWorkOption(key, value)]),
  ]
}

/** A recorded option's value, or "the default" for one left unset. */
export function formatConfig (value: unknown): string {
  if (value === undefined || value === null) return 'the default'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/**
 * What core resolves each recorded option to when it is not given, so the options a person changed
 * can be told apart. A test holds these to core's own `getConfig`.
 */
export const OPTION_DEFAULTS: Readonly<Record<string, unknown>> = {
  adapter: 'pg',
  backend: 'postgres',
  max: 10,
  useListenNotify: false,
  instanceHeartbeatSeconds: 30,
  supervise: true,
  schedule: true,
  migrate: true,
  createSchema: true,
  superviseIntervalSeconds: 60,
  maintenanceIntervalSeconds: 86_400,
  monitorIntervalSeconds: 60,
  queueCacheIntervalSeconds: 60,
  bamIntervalSeconds: 60,
  flowIntervalSeconds: 5,
  reindex: true,
  reindexIntervalSeconds: 86_400,
  monitorVacuum: true,
  clockMonitorIntervalSeconds: 600,
  cronMonitorIntervalSeconds: 30,
  cronWorkerIntervalSeconds: 5,
  persistWarnings: false,
  warningRetentionDays: 365,
  persistQueueStats: false,
  queueStatRetentionDays: 7,
  warningSlowQuerySeconds: 30,
  warningQueueSize: 10_000,
}

/** Whether a recorded option differs from core's default; false for a key with no default to compare, such as `startAttempt`. */
export function isChangedOption (key: string, value: unknown): boolean {
  if (!Object.hasOwn(OPTION_DEFAULTS, key)) return false
  return JSON.stringify(value) !== JSON.stringify(OPTION_DEFAULTS[key])
}

/** What an instance is called: its name, or "unnamed instance" for one started without `instanceName`. */
export function instanceName (name: string | null): string {
  return name ?? 'unnamed instance'
}
