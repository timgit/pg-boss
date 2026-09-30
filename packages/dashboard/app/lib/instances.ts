import type { Instance } from './types'

/** A quiet instance stays in the default view this long after it went quiet, unless a newer start replaced it. */
export const QUIET_LISTED_MS = 60 * 60_000

/** Heartbeats an instance may miss before it reads as quiet, as core judges it. */
const QUIET_BEATS = 3

export type InstanceStatus = 'live' | 'quiet' | 'stopped'

/** Which status filter lists a row. Older quiet rows sit with the stopped ones. */
export type InstanceBucket = InstanceStatus

export interface ListedInstance {
  instance: Instance
  status: InstanceStatus
  bucket: InstanceBucket
  /** A newer instance with the same name on the same host started after this one. */
  replaced: boolean
  /** The newest row for the same name and host, when this is an earlier life that went quiet. */
  foldedUnder: string | null
  /** Earlier lives for the same name and host that went quiet, folded under this row. */
  earlier: Instance[]
}

// Name and host: a process restarted in place keeps both, so this is what "the same instance" means
// to someone reading the list. Unnamed instances on one host share a key, as core's crash count does.
export function instanceKey (instance: Pick<Instance, 'name' | 'host'>): string {
  return `${instance.name ?? ''}\u0000${instance.host}`
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

/**
 * Every row with its status, the filter that lists it, and its place among the lives of the same
 * name and host. Earlier lives that went quiet fold under the newest one, or a crash loop fills the
 * list; stopped rows never fold, since core keeps only the last 20 per name.
 */
export function listInstances (instances: Instance[], now: Date): ListedInstance[] {
  const newest = new Map<string, Instance>()
  for (const i of instances) {
    const head = newest.get(instanceKey(i))
    if (!head || time(i.startedOn) > time(head.startedOn)) newest.set(instanceKey(i), i)
  }

  const listed = instances.map((instance): ListedInstance => {
    const status = instanceStatus(instance)
    const head = newest.get(instanceKey(instance))!
    const replaced = head !== instance
    const recent = now.getTime() - quietSince(instance).getTime() < QUIET_LISTED_MS
    const bucket = status === 'quiet' && (replaced || !recent) ? 'stopped' : status
    return { instance, status, bucket, replaced, foldedUnder: status === 'quiet' && replaced ? head.id : null, earlier: [] }
  })

  const byId = new Map(listed.map((l) => [l.instance.id, l]))
  for (const l of listed) {
    if (l.foldedUnder) byId.get(l.foldedUnder)!.earlier.push(l.instance)
  }
  for (const l of listed) l.earlier.sort((a, b) => time(b.startedOn) - time(a.startedOn))

  return listed
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
