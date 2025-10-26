import { AbortablePromise, delay } from './tools.js'
import type * as types from './types.js'

const WORKER_STATES = {
  created: 'created',
  active: 'active',
  stopping: 'stopping',
  stopped: 'stopped'
} as const

interface WorkerOptions<T> {
  id: string
  name: string
  options: types.WorkOptions
  interval: number
  fetch: () => Promise<types.Job<T>[]>
  onFetch: (jobs: types.Job<T>[]) => Promise<void>
  onError: (err: any) => void
}

class Worker<T = unknown> {
  readonly id: string
  readonly name: string
  readonly options: types.WorkOptions
  readonly fetch: () => Promise<types.Job<T>[]>
  readonly onFetch: (jobs: types.Job<T>[]) => Promise<void>
  readonly onError: (err: any) => void
  readonly interval: number

  jobs: types.Job<T>[] = []
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
  private loopDelayPromise: AbortablePromise<void> | null = null
  private beenNotified = false

  constructor ({ id, name, options, interval, fetch, onFetch, onError }: WorkerOptions<T>) {
    this.id = id
    this.name = name
    this.options = options
    this.fetch = fetch
    this.onFetch = onFetch
    this.onError = onError
    this.interval = interval
  }

  notify () {
    this.beenNotified = true

    if (this.loopDelayPromise) {
      this.loopDelayPromise.abort()
    }
  }

  async start () {
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

  stop () {
    this.stopping = true
    this.state = WORKER_STATES.stopping

    if (this.loopDelayPromise) {
      this.loopDelayPromise.abort()
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
