import { type AbortablePromise, clockDelay } from './tools.ts'
import type * as types from './types.ts'

const WORKER_STATES = {
  created: 'created',
  active: 'active',
  stopping: 'stopping',
  stopped: 'stopped'
} as const

interface WorkerOptions<T> {
  id: string
  workId: string
  name: string
  options: types.WorkOptions
  resolveInterval: (lastFetchCount: number) => number
  fetch: () => Promise<types.Job<T>[]>
  onFetch: (jobs: types.Job<T>[]) => Promise<void>
  onError: (err: any) => void
  clock: types.Clock
}

class Worker<T = unknown> {
  readonly id: string
  readonly workId: string
  readonly name: string
  readonly options: types.WorkOptions
  readonly fetch: () => Promise<types.Job<T>[]>
  readonly onFetch: (jobs: types.Job<T>[]) => Promise<void>
  readonly onError: (err: any) => void
  readonly resolveInterval: (lastFetchCount: number) => number
  readonly clock: types.Clock

  jobs: types.Job<T>[] = []
  createdOn: number
  state: types.WorkerState = WORKER_STATES.created
  lastFetchedOn: number | null = null
  lastJobStartedOn: number | null = null
  lastJobEndedOn: number | null = null
  lastJobDuration: number | null = null
  lastError: any = null
  lastErrorOn: number | null = null
  stopping = false
  stopped = false
  abortController: AbortController | null = null
  // Set when a shutdown abandons the batch in flight. Manager reads it to tell that apart from the
  // handler finishing on its own: the abort resolves the handler race rather than rejecting it, so
  // the signal alone says nothing, and the timeout wired into the same controller trips it on every
  // ordinary completion. Reset per batch by the manager, beside abortController.
  aborted = false
  private loopDelayPromise: AbortablePromise<void> | null = null
  private beenNotified = false
  private runPromise: Promise<void> | null = null

  constructor ({ id, workId, name, options, resolveInterval, fetch, onFetch, onError, clock }: WorkerOptions<T>) {
    this.clock = clock
    this.createdOn = clock.now()
    this.id = id
    this.workId = workId
    this.name = name
    this.options = options
    this.fetch = fetch
    this.onFetch = onFetch
    this.onError = onError
    this.resolveInterval = resolveInterval
  }

  start () {
    this.runPromise = this.run()
  }

  private async run () {
    this.state = WORKER_STATES.active

    while (!this.stopping) {
      const started = this.clock.now()

      // Number of jobs the last fetch returned; stays 0 on error so a failed fetch backs
      // off to normal polling instead of hot-looping in burst mode.
      let fetchedCount = 0

      try {
        this.beenNotified = false
        const jobs = await this.fetch()

        this.lastFetchedOn = this.clock.now()

        if (jobs) {
          fetchedCount = jobs.length
          this.jobs = jobs

          this.lastJobStartedOn = this.lastFetchedOn

          await this.onFetch(jobs)

          this.lastJobEndedOn = this.clock.now()

          this.jobs = []
        }
      } catch (err: any) {
        this.lastErrorOn = this.clock.now()
        this.lastError = err

        err.message = `${err.message} (Queue: ${this.name}, Worker: ${this.id})`

        this.onError(err)
      }

      const duration = this.clock.now() - started

      this.lastJobDuration = duration

      // Resolve the effective delay each iteration: burst (continuous), NOTIFY backstop, or
      // the base poll (see Manager.work). fetchedCount lets the resolver keep going only while
      // fetches come back full — a short fetch resumes normal polling. A returned interval
      // <= duration + 100 (0 in burst mode) skips the delay and re-fetches immediately.
      const interval = this.resolveInterval(fetchedCount)

      if (!this.stopping && !this.beenNotified && (interval - duration) > 100) {
        this.loopDelayPromise = clockDelay(this.clock, interval - duration)
        await this.loopDelayPromise
        this.loopDelayPromise = null
      }
    }

    this.stopping = false
    this.stopped = true
    this.state = WORKER_STATES.stopped
  }

  notify () {
    this.beenNotified = true

    if (this.loopDelayPromise) {
      this.loopDelayPromise.abort()
    }
  }

  async stop (): Promise<void> {
    // Idempotent: run() has already reset `stopping` and exited, so a second stop would strand the
    // worker in `stopping` with nothing left to clear it. Overlapping stops on a *live* worker are
    // fine - they all await the one `runPromise` - so only the settled case needs the guard.
    if (this.stopped) return

    this.stopping = true
    this.state = WORKER_STATES.stopping

    if (this.loopDelayPromise) {
      this.loopDelayPromise.abort()
    }

    await this.runPromise
  }

  abort (): void {
    if (!this.abortController) return

    this.aborted = true

    if (!this.abortController.signal.aborted) {
      this.abortController.abort()
    }
  }

  toWipData (): types.WipData {
    return {
      id: this.id,
      workId: this.workId,
      name: this.name,
      options: this.options,
      state: this.state,
      count: this.jobs.length,
      createdOn: this.createdOn,
      lastFetchedOn: this.lastFetchedOn,
      lastJobStartedOn: this.lastJobStartedOn,
      lastJobEndedOn: this.lastJobEndedOn,
      lastError: this.lastError,
      lastErrorOn: this.lastErrorOn,
      lastJobDuration: this.lastJobDuration
    }
  }
}

export default Worker
