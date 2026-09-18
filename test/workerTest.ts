import { expect } from 'vitest'
import Worker from '../src/worker.ts'
import { systemClock } from '../src/clock.ts'
import type { Job } from '../src/types.ts'

// Direct unit coverage for Worker's self-contained guards. The manager suites drive Worker through
// work()/offWork(), which cannot deterministically land inside the windows these guards exist for.

// A latch the loop can trip from inside fetch, so a test waits on the first pass rather than
// spinning on a counter.
function latch () {
  let open: () => void = () => { throw new Error('Latch not initialized') }
  const opened = new Promise<void>(resolve => { open = resolve })
  return { opened, open: () => open() }
}

function buildWorker (overrides: Partial<{
  fetch: () => Promise<Job<unknown>[]>
  resolveInterval: (lastFetchCount: number) => number
  onFetch: (jobs: Job<unknown>[]) => Promise<void>
  onError: (err: any) => void
}> = {}) {
  return new Worker<unknown>({
    id: 'worker-id',
    workId: 'work-id',
    name: 'queue',
    options: {},
    resolveInterval: overrides.resolveInterval ?? (() => 60_000),
    fetch: overrides.fetch ?? (async () => []),
    onFetch: overrides.onFetch ?? (async () => {}),
    onError: overrides.onError ?? (() => {}),
    clock: systemClock
  })
}

describe('worker', function () {
  it('stop() on a settled worker leaves it stopped instead of stranding it in stopping', async function () {
    const worker = buildWorker()

    worker.start()
    await worker.stop()

    expect(worker.stopped).toBe(true)
    expect(worker.stopping).toBe(false)
    expect(worker.state).toBe('stopped')

    // run() has already exited, so there is nothing left to reset the flags a second stop would set.
    // offWork no longer filters on lifecycle flags, so Worker owns this guard: without it the worker
    // ends at state 'stopping' and would survive getWipData()'s state !== 'stopped' filter forever.
    await worker.stop()
    await worker.stop()

    expect(worker.stopped).toBe(true)
    expect(worker.stopping).toBe(false)
    expect(worker.state).toBe('stopped')
  })

  it('overlapping stops on a live worker all settle together', async function () {
    let releaseHandler: () => void = () => { throw new Error('Release promise not initialized') }
    const release = new Promise<void>(resolve => { releaseHandler = resolve })
    const handling = latch()

    const worker = buildWorker({
      fetch: async () => [{ id: 'job' } as Job<unknown>],
      onFetch: async () => {
        handling.open()
        await release
      }
    })

    worker.start()

    await handling.opened

    const settled: number[] = []
    const stops = [0, 1, 2].map(i => worker.stop().then(() => settled.push(i)))

    expect(settled).toHaveLength(0)

    releaseHandler()
    await Promise.all(stops)

    // All three awaited the one runPromise, so none of them could resolve before the handler did.
    expect(settled).toHaveLength(3)
    expect(worker.state).toBe('stopped')
  })

  it('a fetch that returns nothing skips the batch and keeps polling', async function () {
    const fetching = latch()

    const worker = buildWorker({
      fetch: async () => {
        fetching.open()
        return null as unknown as Job<unknown>[]
      },
      onFetch: async () => { throw new Error('onFetch must not run for an empty fetch') }
    })

    worker.start()

    await fetching.opened

    // lastFetchedOn is stamped after the fetch resolves, so the latch alone is a pass too early.
    while (worker.lastFetchedOn === null) {
      await new Promise(resolve => setImmediate(resolve))
    }

    expect(worker.lastJobStartedOn).toBeNull()
    expect(worker.jobs).toHaveLength(0)

    await worker.stop()

    expect(worker.state).toBe('stopped')
  })

  it('abort() is a no-op once the controller has already been aborted', function () {
    const worker = buildWorker()

    // No controller yet: nothing to abort, and `aborted` must stay false so the manager does not
    // read an abandoned batch where none happened.
    worker.abort()
    expect(worker.aborted).toBe(false)

    const controller = new AbortController()
    worker.abortController = controller

    worker.abort()
    expect(worker.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(true)

    worker.abort()
    expect(controller.signal.aborted).toBe(true)
  })

  it('an error from fetch is reported and does not stop the loop', async function () {
    const errors: any[] = []
    const reported = latch()

    const worker = buildWorker({
      fetch: async () => { throw new Error('fetch exploded') },
      onError: err => {
        errors.push(err)
        reported.open()
      }
    })

    worker.start()

    await reported.opened
    await worker.stop()

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('fetch exploded (Queue: queue, Worker: worker-id)')
    expect(worker.lastError).toBe(errors[0])
    expect(worker.state).toBe('stopped')
  })
})
