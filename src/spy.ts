export type JobSpyState = 'created' | 'active' | 'completed' | 'failed'

export type JobDataSelector<T = object> = (jobData: T) => boolean

export type JobSelector<T = object> = (job: SpyJob<T>) => boolean

export interface SpyJob<T = object> {
  id: string
  name: string
  data: T
  state: JobSpyState
  output?: object
}

export interface JobSpyInterface<T = object> {
  clear(): void
  waitForJob(
    selector: JobDataSelector<T>,
    state: JobSpyState
  ): Promise<SpyJob<T>>
  waitForJobWithId(
    id: string,
    state: JobSpyState
  ): Promise<SpyJob<T>>
}

type SpyPromise<T = object> = {
  selector: JobSelector<T>
  awaitedState: JobSpyState
  resolve: (job: SpyJob<T>) => void
}

export class JobSpy<T = object> implements JobSpyInterface<T> {
  #jobResults: Map<string, SpyJob<T>> = new Map()
  #pendingPromises: SpyPromise<T>[] = []

  clear (): void {
    this.#jobResults.clear()
    this.#pendingPromises = []
  }

  waitForJobWithId (id: string, awaitedState: JobSpyState): Promise<SpyJob<T>> {
    return this.waitForJob(() => true, awaitedState, id)
  }

  waitForJob (
    dataSelector: JobDataSelector<T>,
    awaitedState: JobSpyState,
    specificId?: string
  ): Promise<SpyJob<T>> {
    const selector: JobSelector<T> = (job) => {
      if (specificId && job.id !== specificId) {
        return false
      }
      return dataSelector(job.data)
    }

    // Check if we already have a matching job
    for (const job of this.#jobResults.values()) {
      if (job.state === awaitedState && selector(job)) {
        return Promise.resolve(this.#cloneJob(job))
      }
    }

    // Register promise to be resolved when job arrives
    return this.#registerPromise(selector, awaitedState)
  }

  #registerPromise (
    selector: JobSelector<T>,
    awaitedState: JobSpyState
  ): Promise<SpyJob<T>> {
    let resolve!: (job: SpyJob<T>) => void

    const promise = new Promise<SpyJob<T>>((_resolve) => {
      resolve = _resolve
    })

    this.#pendingPromises.push({ selector, awaitedState, resolve })

    return promise
  }

  #getJobResultKey (id: string, state: JobSpyState): string {
    return `${id}:${state}`
  }

  #cloneJob (job: SpyJob<T>): SpyJob<T> {
    return {
      id: job.id,
      name: job.name,
      data: structuredClone(job.data),
      state: job.state,
      output: job.output ? structuredClone(job.output) : undefined
    }
  }

  addJob (
    id: string,
    name: string,
    data: T,
    state: JobSpyState,
    output?: object
  ): void {
    const job: SpyJob<T> = {
      id,
      name,
      data: structuredClone(data),
      state,
      output: output ? structuredClone(output) : undefined
    }

    const key = this.#getJobResultKey(id, state)
    this.#jobResults.set(key, job)

    // Resolve any pending promises that match this job
    const matchingPromises: SpyPromise<T>[] = []
    const remainingPromises: SpyPromise<T>[] = []

    for (const pending of this.#pendingPromises) {
      if (pending.awaitedState === state && pending.selector(job)) {
        matchingPromises.push(pending)
      } else {
        remainingPromises.push(pending)
      }
    }

    this.#pendingPromises = remainingPromises

    for (const pending of matchingPromises) {
      pending.resolve(this.#cloneJob(job))
    }
  }
}
