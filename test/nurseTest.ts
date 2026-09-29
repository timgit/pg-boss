import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { it } from 'vitest'
import { expect } from './hooks.ts'
import Nurse, { findCgroup, countCpuList } from '../src/nurse.ts'

// A fake root holding the /proc and /sys files a container would show, keyed by absolute path.
async function fakeRoot (files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pgboss-cgroup-'))
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(root + file), { recursive: true })
    await writeFile(root + file, text)
  }
  return root
}

async function sampleOnce (files: Record<string, string>) {
  const root = await fakeRoot(files)
  try {
    const m = new Nurse(root)
    m.start()
    const s = await m.sample()
    m.stop()
    return s
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const V2_MOUNT = '2862 2861 0:29 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw,nsdelegate\n'
const ALL_CPUS = 'Name:\tnode\nCpus_allowed_list:\t0-11\n'
const MiB = 1024 * 1024

describe('nurse', function () {
  it('reads a cgroup v2 container with its own namespace: docker run --cpus=0.5 --memory=200m', async function () {
    const s = await sampleOnce({
      '/proc/self/cgroup': '0::/\n',
      '/proc/self/mountinfo': V2_MOUNT,
      '/proc/self/status': ALL_CPUS,
      '/sys/fs/cgroup/cpu.max': '50000 100000\n',
      '/sys/fs/cgroup/cpu.stat': 'usage_usec 1\nnr_periods 10\nnr_throttled 2\n',
      '/sys/fs/cgroup/memory.max': `${200 * MiB}\n`,
      '/sys/fs/cgroup/memory.current': `${90 * MiB}\n`,
      '/sys/fs/cgroup/memory.stat': `anon 1\ninactive_file ${30 * MiB}\nactive_file 5\n`
    })

    expect(s.cgroup).toBe(2)
    expect(s.cpuLimit).toBe(0.5)
    expect(s.memoryLimit).toBe(200 * MiB)
    expect(s.memoryUsed).toBe(60 * MiB)
    // Throttling is a rate, so the first sample has nothing to compare with.
    expect(s.cpuThrottled).toBeNull()
  })

  it('follows /proc/self/cgroup under a host namespace and takes the tightest limit up the tree', async function () {
    const pod = '/sys/fs/cgroup/kubepods.slice/pod1'
    const s = await sampleOnce({
      '/proc/self/cgroup': '0::/kubepods.slice/pod1/ctr\n',
      '/proc/self/mountinfo': V2_MOUNT,
      '/proc/self/status': ALL_CPUS,
      // The pod holds the CPU quota and the tighter memory limit sits on the container.
      [pod + '/cpu.max']: '200000 100000\n',
      [pod + '/memory.max']: `${1024 * MiB}\n`,
      [pod + '/ctr/cpu.max']: 'max 100000\n',
      [pod + '/ctr/memory.max']: `${512 * MiB}\n`,
      [pod + '/ctr/memory.current']: `${100 * MiB}\n`,
      [pod + '/ctr/memory.stat']: 'inactive_file 0\n'
    })

    expect(s.cgroup).toBe(2)
    expect(s.cpuLimit).toBe(2)
    expect(s.memoryLimit).toBe(512 * MiB)
    expect(s.memoryUsed).toBe(100 * MiB)
  })

  it('reads cgroup v1 as docker mounts it, each controller rooted at the container', async function () {
    const s = await sampleOnce({
      '/proc/self/cgroup': '12:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n1:name=systemd:/docker/abc\n',
      '/proc/self/mountinfo': [
        '30 25 0:26 /docker/abc /sys/fs/cgroup/memory ro,nosuid - cgroup cgroup rw,memory',
        '31 25 0:27 /docker/abc /sys/fs/cgroup/cpu,cpuacct ro,nosuid - cgroup cgroup rw,cpu,cpuacct',
        ''
      ].join('\n'),
      '/proc/self/status': ALL_CPUS,
      '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us': '150000\n',
      '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us': '100000\n',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${300 * MiB}\n`,
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${80 * MiB}\n`,
      '/sys/fs/cgroup/memory/memory.stat': `cache 1\ntotal_inactive_file ${20 * MiB}\n`
    })

    expect(s.cgroup).toBe(1)
    expect(s.cpuLimit).toBe(1.5)
    expect(s.memoryLimit).toBe(300 * MiB)
    expect(s.memoryUsed).toBe(60 * MiB)
  })

  it('falls back to the host where a cgroup sets no limit', async function () {
    const s = await sampleOnce({
      '/proc/self/cgroup': '12:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n',
      '/proc/self/mountinfo': [
        '30 25 0:26 /docker/abc /sys/fs/cgroup/memory ro - cgroup cgroup rw,memory',
        '31 25 0:27 /docker/abc /sys/fs/cgroup/cpu ro - cgroup cgroup rw,cpu',
        ''
      ].join('\n'),
      '/proc/self/status': 'Cpus_allowed_list:\t0-3\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n'
    })

    expect(s.cgroup).toBe(1)
    expect(s.cpuLimit).toBe(4)
    expect(s.cpuThrottled).toBeNull()
    expect(s.memoryLimit).toBe(os.totalmem())
    expect(s.memoryUsed).toBeNull()
  })

  it('caps a CPU quota at the CPUs the process may run on', async function () {
    const s = await sampleOnce({
      '/proc/self/cgroup': '0::/\n',
      '/proc/self/mountinfo': V2_MOUNT,
      '/proc/self/status': 'Cpus_allowed_list:\t0-1\n',
      '/sys/fs/cgroup/cpu.max': '400000 100000\n'
    })

    expect(s.cpuLimit).toBe(2)
  })

  it('uses the host off Linux, where there is no /proc', async function () {
    const s = await sampleOnce({})

    expect(s.cgroup).toBeNull()
    expect(s.cpuLimit).toBe(os.availableParallelism())
    expect(s.memoryLimit).toBe(os.totalmem())
    expect(s.memoryUsed).toBeNull()
    expect(s.cpuThrottled).toBeNull()
    expect(s.rss).toBeGreaterThan(0)
    expect(s.heapUsed).toBeGreaterThan(0)
  })

  it('prefers v1 controllers over an empty unified hierarchy on a hybrid host', async function () {
    const root = await fakeRoot({
      '/proc/self/cgroup': '4:memory:/app\n0::/app\n',
      '/proc/self/mountinfo': [
        '30 25 0:26 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory',
        '31 25 0:28 / /sys/fs/cgroup/unified rw - cgroup2 cgroup2 rw',
        ''
      ].join('\n')
    })

    try {
      const cg = await findCgroup(root)
      expect(cg?.version).toBe(1)
      expect(cg?.memory?.dirs).toEqual([root + '/sys/fs/cgroup/memory/app', root + '/sys/fs/cgroup/memory'])
      expect(cg?.cpu).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('assumes the usual /sys/fs/cgroup layout when mountinfo cannot be read', async function () {
    const s = await sampleOnce({
      '/proc/self/cgroup': '0::/system.slice/app.scope\n',
      '/proc/self/status': ALL_CPUS,
      '/sys/fs/cgroup/system.slice/app.scope/cpu.max': '150000 100000\n',
      '/sys/fs/cgroup/system.slice/memory.max': `${256 * MiB}\n`,
      '/sys/fs/cgroup/system.slice/memory.current': `${64 * MiB}\n`
    })

    expect(s.cgroup).toBe(2)
    expect(s.cpuLimit).toBe(1.5)
    expect(s.memoryLimit).toBe(256 * MiB)
    expect(s.memoryUsed).toBe(64 * MiB)
  })

  it('reports throttling between samples, from the cgroup that holds the quota', async function () {
    const root = await fakeRoot({
      '/proc/self/cgroup': '0::/\n',
      '/proc/self/mountinfo': V2_MOUNT,
      '/proc/self/status': ALL_CPUS,
      '/sys/fs/cgroup/cpu.max': '100000 100000\n',
      '/sys/fs/cgroup/cpu.stat': 'nr_periods 100\nnr_throttled 10\n'
    })

    try {
      const m = new Nurse(root)
      m.start()
      await m.sample()
      await writeFile(root + '/sys/fs/cgroup/cpu.stat', 'nr_periods 300\nnr_throttled 60\n')
      expect((await m.sample()).cpuThrottled).toBe(0.25)
      m.stop()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('measures CPU, event loop delay and utilization since the previous sample', async function () {
    const m = new Nurse()
    m.start()

    const first = await m.sample()
    expect(first.cpu).toBeNull()

    // Block the loop on a later tick, so the delay monitor has a timer waiting behind it.
    await new Promise(resolve => setTimeout(resolve, 50))
    const until = performance.now() + 250
    while (performance.now() < until);
    await new Promise(resolve => setTimeout(resolve, 50))

    const s = await m.sample()
    m.stop()

    expect(s.cpu).toBeGreaterThan(0.3)
    expect(s.loopDelayMax).toBeGreaterThan(150)
    expect(s.loopUtilization).toBeGreaterThan(0.3)
  })

  it('counts a CPU list', function () {
    expect(countCpuList('0-3,8,10-11')).toBe(7)
    expect(countCpuList('0')).toBe(1)
    expect(countCpuList('')).toBeNull()
  })
})
