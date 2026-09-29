import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import v8 from 'node:v8'
import type * as types from './types.ts'

// Takes this process's vitals on each registry heartbeat: what it is using and what it is allowed. Inside a
// container the host-wide figures Node offers are the wrong ones: os.totalmem(), os.freemem(),
// os.loadavg() and os.cpus() describe the machine, not the container, and os.availableParallelism()
// ignores a CPU quota under one core (12 at --cpus=0.5) and rounds others down (1 at --cpus=1.5). So
// limits and container usage are read from the cgroup files this process is charged to, found through
// /proc/self/cgroup and /proc/self/mountinfo, which covers cgroup v1 and v2 and a private or host
// cgroup namespace alike. Off Linux, or where those files cannot be read, the limits fall back to the
// host and the container-only figures are null. Nothing here throws: a figure that cannot be read is
// null, and the heartbeat goes out regardless.

// Event loop delay is sampled on a timer of this resolution, which every sample includes and which is
// subtracted, so an idle loop reads close to zero.
const LOOP_RESOLUTION_MS = 20

// cgroup v1 writes "no limit" as the largest page-aligned int64, not as a word.
const V1_UNLIMITED = 2 ** 60

interface Hierarchy {
  // The directories this process's limits can be set on: its own cgroup first, then each parent up to
  // the root of the mount, since a limit on a parent (a Kubernetes pod, a systemd slice) binds too.
  dirs: string[]
}

export interface Cgroup {
  version: 1 | 2
  cpu: Hierarchy | null
  memory: Hierarchy | null
}

interface Mount {
  root: string
  mountPoint: string
  fsType: string
  superOptions: string[]
}

// mountinfo escapes spaces and other octal characters in paths as \NNN.
const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)))

function parseMountInfo (text: string): Mount[] {
  const mounts: Mount[] = []

  for (const line of text.split('\n')) {
    const sep = line.indexOf(' - ')
    if (sep < 0) continue

    const pre = line.slice(0, sep).split(' ')
    const post = line.slice(sep + 3).split(' ')

    if (pre.length < 5 || post.length < 3) continue

    mounts.push({ root: unescape(pre[3]), mountPoint: unescape(pre[4]), fsType: post[0], superOptions: post[2].split(',') })
  }

  return mounts
}

// Maps a cgroup path, as /proc/self/cgroup gives it, to directories under the mount that shows it. A
// mount's root is the part of the hierarchy it exposes: "/" for a whole hierarchy or a private cgroup
// namespace, the container's own cgroup for Docker on cgroup v1.
function hierarchy (prefix: string, mount: Mount, path: string): Hierarchy {
  let rel = path
  if (mount.root !== '/') {
    rel = path === mount.root || path.startsWith(mount.root + '/') ? path.slice(mount.root.length) : ''
  }

  const base = prefix + mount.mountPoint
  const parts = rel.split('/').filter(Boolean)
  const dirs: string[] = []

  for (let i = parts.length; i >= 0; i--) {
    dirs.push([base, ...parts.slice(0, i)].join('/'))
  }

  return { dirs }
}

// Finds the cgroup this process is charged to. `prefix` is prepended to every path read, for tests.
export async function findCgroup (prefix = ''): Promise<Cgroup | null> {
  let self: string
  try {
    self = await readFile(prefix + '/proc/self/cgroup', 'utf8')
  } catch {
    return null
  }

  const entries = self.split('\n').filter(Boolean).map(line => {
    const [id, controllers, ...path] = line.split(':')
    return { id, controllers: controllers ? controllers.split(',') : [], path: path.join(':') }
  })

  // A sandbox can refuse mountinfo while allowing the rest (AppArmor under snap does). Then assume
  // the usual layout, each hierarchy mounted whole under /sys/fs/cgroup: walking up from the path
  // still reaches the mount's root, which is the container's own cgroup under a private namespace
  // and under Docker's v1 mounts alike.
  let mounts: Mount[]
  try {
    mounts = parseMountInfo(await readFile(prefix + '/proc/self/mountinfo', 'utf8'))
  } catch {
    mounts = entries.map(e => e.controllers.length
      ? { root: '/', mountPoint: '/sys/fs/cgroup/' + e.controllers.join(','), fsType: 'cgroup', superOptions: e.controllers }
      : { root: '/', mountPoint: '/sys/fs/cgroup', fsType: 'cgroup2', superOptions: [] })
  }

  // A v1 hierarchy for a controller wins over a v2 one: on a hybrid host the unified hierarchy is
  // mounted but the cpu and memory controllers stay on v1.
  const v1 = (controller: string) => {
    const entry = entries.find(e => e.controllers.includes(controller))
    const mount = mounts.find(m => m.fsType === 'cgroup' && m.superOptions.includes(controller))
    return entry && mount ? hierarchy(prefix, mount, entry.path) : null
  }

  const cpu = v1('cpu')
  const memory = v1('memory')

  if (cpu || memory) {
    return { version: 1, cpu, memory }
  }

  const unified = entries.find(e => e.id === '0' && e.controllers.length === 0)
  const mount = mounts.find(m => m.fsType === 'cgroup2')

  if (unified && mount) {
    const h = hierarchy(prefix, mount, unified.path)
    return { version: 2, cpu: h, memory: h }
  }

  return null
}

async function read (path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return null
  }
}

function statField (text: string | null, key: string): number | null {
  if (!text) return null
  const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(text)
  return m ? Number(m[1]) : null
}

interface Limit {
  value: number
  dir: string
}

// The tightest CPU quota in cores on this cgroup or a parent, and where it is set.
async function cpuQuota (cg: Cgroup): Promise<Limit | null> {
  if (!cg.cpu) return null
  let best: Limit | null = null

  for (const dir of cg.cpu.dirs) {
    let cores: number | null = null

    if (cg.version === 2) {
      const [quota, period] = (await read(dir + '/cpu.max'))?.split(' ') ?? []
      if (quota && quota !== 'max' && Number(period) > 0) cores = Number(quota) / Number(period)
    } else {
      const quota = Number(await read(dir + '/cpu.cfs_quota_us'))
      const period = Number(await read(dir + '/cpu.cfs_period_us'))
      if (quota > 0 && period > 0) cores = quota / period
    }

    if (cores !== null && cores > 0 && (!best || cores < best.value)) best = { value: cores, dir }
  }

  return best
}

// The tightest memory limit in bytes on this cgroup or a parent, and where it is set.
async function memoryLimit (cg: Cgroup): Promise<Limit | null> {
  if (!cg.memory) return null
  let best: Limit | null = null

  for (const dir of cg.memory.dirs) {
    const text = await read(dir + (cg.version === 2 ? '/memory.max' : '/memory.limit_in_bytes'))
    if (!text || text === 'max') continue

    const bytes = Number(text)
    if (!(bytes > 0) || bytes >= V1_UNLIMITED) continue

    if (!best || bytes < best.value) best = { value: bytes, dir }
  }

  return best
}

// Memory in use by the cgroup less its inactive file cache: the working set that container runtimes
// and the kubelet compare against the limit, since inactive cache is reclaimed before anything is killed.
async function workingSet (cg: Cgroup, dir: string): Promise<number | null> {
  const usage = Number(await read(dir + (cg.version === 2 ? '/memory.current' : '/memory.usage_in_bytes')))
  if (!(usage >= 0)) return null

  const inactive = statField(await read(dir + '/memory.stat'), cg.version === 2 ? 'inactive_file' : 'total_inactive_file') ?? 0

  return Math.max(0, usage - inactive)
}

// Counts the CPUs this process may be scheduled on, from a list such as "0-3,8,10-11".
export function countCpuList (list: string): number | null {
  let n = 0

  for (const part of list.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) return null
    n += m[2] === undefined ? 1 : Number(m[2]) - Number(m[1]) + 1
  }

  return n > 0 ? n : null
}

async function allowedCpus (prefix: string): Promise<number> {
  const status = await read(prefix + '/proc/self/status')
  const list = status && /^Cpus_allowed_list:\s*(\S+)$/m.exec(status)?.[1]
  const n = list ? countCpuList(list) : null

  return n ?? os.availableParallelism()
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

class Nurse {
  #prefix: string
  #cgroup: Promise<Cgroup | null> | null = null
  #loop: ReturnType<typeof monitorEventLoopDelay> | null = null
  #elu: ReturnType<typeof performance.eventLoopUtilization> | null = null
  #cpu: NodeJS.CpuUsage | null = null
  #at: bigint | null = null
  #throttle: { dir: string, periods: number, throttled: number } | null = null

  constructor (prefix = '') {
    this.#prefix = prefix
  }

  start () {
    this.#cgroup = findCgroup(this.#prefix).catch(() => null)

    try {
      this.#loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS })
      this.#loop.enable()
    } catch {
      this.#loop = null
    }

    this.#cpu = null
    this.#at = null
    this.#elu = null
    this.#throttle = null
  }

  stop () {
    this.#loop?.disable()
    this.#loop = null
  }

  // Rates cover the time since the previous sample. The first sample after start() only sets the
  // baseline, since at registration it would cover a few microseconds, so its rates are null.
  async sample (): Promise<types.InstanceMetrics> {
    const first = this.#at === null
    const now = process.hrtime.bigint()
    const cpuNow = process.cpuUsage()

    const elapsedMicros = first ? 0 : Number(now - this.#at!) / 1000
    const cpu = !first && this.#cpu && elapsedMicros > 0
      ? ((cpuNow.user - this.#cpu.user) + (cpuNow.system - this.#cpu.system)) / elapsedMicros
      : null

    this.#cpu = cpuNow
    this.#at = now

    let loopDelay: number | null = null
    let loopDelayMax: number | null = null
    if (this.#loop) {
      if (!first && this.#loop.count > 0) {
        loopDelay = Math.max(0, this.#loop.percentile(99) / 1e6 - LOOP_RESOLUTION_MS)
        loopDelayMax = Math.max(0, this.#loop.max / 1e6 - LOOP_RESOLUTION_MS)
      }
      this.#loop.reset()
    }

    let loopUtilization: number | null = null
    try {
      const next = performance.eventLoopUtilization()
      // Bun's is a stub that always reads zero, which would chart as an idle loop.
      if (next.idle === 0 && next.active === 0) throw new Error('unsupported')
      if (!first && this.#elu) loopUtilization = performance.eventLoopUtilization(next, this.#elu).utilization
      this.#elu = next
    } catch {}

    let heapUsed: number | null = null
    let heapLimit: number | null = null
    try {
      const heap = v8.getHeapStatistics()
      heapUsed = heap.used_heap_size
      heapLimit = heap.heap_size_limit
    } catch {}

    let rss: number | null = null
    try {
      rss = process.memoryUsage.rss()
    } catch {}

    const cg = await this.#cgroup
    const quota = cg ? await cpuQuota(cg) : null
    const memLimit = cg ? await memoryLimit(cg) : null
    const cpus = await allowedCpus(this.#prefix)

    return {
      cgroup: cg?.version ?? null,
      cpu: cpu === null ? null : round(cpu, 3),
      cpuLimit: round(quota ? Math.min(quota.value, cpus) : cpus, 3),
      cpuThrottled: cg && quota ? await this.#throttled(cg, quota.dir) : null,
      rss,
      heapUsed,
      heapLimit,
      memoryUsed: cg && memLimit ? await workingSet(cg, memLimit.dir) : null,
      memoryLimit: memLimit ? memLimit.value : os.totalmem(),
      loopDelay: loopDelay === null ? null : round(loopDelay, 1),
      loopDelayMax: loopDelayMax === null ? null : round(loopDelayMax, 1),
      loopUtilization: loopUtilization === null ? null : round(loopUtilization, 3)
    }
  }

  // The share of CPU periods since the previous sample in which the cgroup that holds the quota ran
  // out of it and was paused. Null on the first sample, or when the quota moved to another cgroup.
  async #throttled (cg: Cgroup, dir: string): Promise<number | null> {
    const text = await read(dir + '/cpu.stat')
    const periods = statField(text, 'nr_periods')
    const throttled = statField(text, 'nr_throttled')

    if (periods === null || throttled === null) return null

    const prev = this.#throttle
    this.#throttle = { dir, periods, throttled }

    if (!prev || prev.dir !== dir) return null

    const dp = periods - prev.periods
    return dp > 0 ? round((throttled - prev.throttled) / dp, 3) : 0
  }
}

export default Nurse
