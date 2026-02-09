import { type AbortablePromise, delay } from './tools.ts'
import type * as types from './types.ts'

const WORKER_STATES = {
  created: 'created',
  active: 'active',
  stopping: 'stopping',
  stopped: 'stopped'
} as const

interface WorkerOptions<C extends types.JobsConfig, N extends types.JobNames<C>> {
  id: string
  name: string
  options: types.WorkOptions
  interval: number
  fetch: () => Promise<types.Job<C, N>[]>
  onFetch: (jobs: types.Job<C, N>[]) => Promise<void>
  onError: (err: any) => void
}

class Worker<C extends types.JobsConfig, N extends types.JobNames<C>> {
  readonly id: string
  readonly name: string
  readonly options: types.WorkOptions
  readonly fetch: () => Promise<types.Job<C, N>[]>
  readonly onFetch: (jobs: types.Job<C, N>[]) => Promise<void>
  readonly onError: (err: any) => void
  readonly interval: number

  jobs: types.Job<C, N>[] = []
  createdOn = Date.now()
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
  private loopDelayPromise: AbortablePromise<void> | null = null
  private beenNotified = false
  private runPromise: Promise<void> | null = null

  constructor ({ id, name, options, interval, fetch, onFetch, onError }: WorkerOptions<C, N>) {
    this.id = id
    this.name = name
    this.options = options
    this.fetch = fetch
    this.onFetch = onFetch
    this.onError = onError
    this.interval = interval
  }

  start () {
    this.runPromise = this.run()
  }

  private async run () {
    this.state = WORKER_STATES.active

    while (!this.stopping) {
      const started = Date.now()

      try {
        this.beenNotified = false
        const jobs = await this.fetch()

        this.lastFetchedOn = Date.now()

        if (jobs) {
          this.jobs = jobs

          this.lastJobStartedOn = this.lastFetchedOn

          await this.onFetch(jobs)

          this.lastJobEndedOn = Date.now()

          this.jobs = []
        }
      } catch (err: any) {
        this.lastErrorOn = Date.now()
        this.lastError = err

        err.message = `${err.message} (Queue: ${this.name}, Worker: ${this.id})`

        this.onError(err)
      }

      const duration = Date.now() - started

      this.lastJobDuration = duration

      if (!this.stopping && !this.beenNotified && (this.interval - duration) > 100) {
        this.loopDelayPromise = delay(this.interval - duration)
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
    this.stopping = true
    this.state = WORKER_STATES.stopping

    if (this.loopDelayPromise) {
      this.loopDelayPromise.abort()
    }

    await this.runPromise
  }

  abort (): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort()
    }
  }

  toWipData (): types.WipData {
    return {
      id: this.id,
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
