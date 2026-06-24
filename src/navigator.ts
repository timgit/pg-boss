import EventEmitter from 'node:events'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import { delay } from './tools.ts'
import * as types from './types.ts'

const events = {
  error: 'error',
  flow: 'flow'
}

// Cap audit batches per resolve pass so a large backlog can't monopolize the loop; whatever is
// left over is picked up on the next poll.
const MAX_BATCHES_PER_PASS = 100

// Background flow resolver. Completion is kept on a join-free hot path (see issue #824); the
// dependency bookkeeping that used to run inline now happens here, out of band. Modeled on the
// Bam poller: on each tick it claims the cluster-wide cadence gate (version.flow_on) and, if it
// wins, audits for completed "blocking" parents via the job_i9 partial index, decrements their
// children, unblocks those reaching zero, and clears the parents' blocking flag so they are not
// reprocessed. The Guild Navigator that keeps the spice flowing.
class Navigator extends EventEmitter implements types.EventsMixin {
  #stopped: boolean
  #stopping: boolean
  #working: boolean
  #pollInterval: NodeJS.Timeout | undefined
  #db: types.IDatabase
  #manager: Manager
  #config: types.ResolvedConstructorOptions

  events = events

  constructor (
    db: types.IDatabase,
    manager: Manager,
    config: types.ResolvedConstructorOptions
  ) {
    super()

    this.#db = db
    this.#manager = manager
    this.#config = config
    this.#stopped = true
    this.#stopping = false
    this.#working = false
  }

  get working (): boolean {
    return this.#working
  }

  async start () {
    if (!this.#stopped) return
    this.#stopped = false
    this.#stopping = false

    setImmediate(() => this.#onPoll())
    this.#pollInterval = setInterval(
      () => this.#onPoll(),
      this.#config.flowIntervalSeconds * 1000
    )
  }

  async stop () {
    if (this.#stopped) return
    this.#stopping = true
    this.#stopped = true

    if (this.#pollInterval) {
      clearInterval(this.#pollInterval)
      this.#pollInterval = undefined
    }

    while (this.#working) {
      await delay(10)
    }
  }

  async #onPoll () {
    if (this.#stopped || this.#working) return

    this.#working = true

    try {
      if (this.#config.__test__throw_flow) {
        throw new Error(this.#config.__test__throw_flow)
      }

      if (this.#config.__test__delay_flow_ms) {
        await delay(this.#config.__test__delay_flow_ms)
      }

      const gate = plans.trySetFlowTime(this.#config.schema, this.#config.flowIntervalSeconds)
      const { rows } = await this.#db.executeSql(gate)

      if (rows.length === 1) {
        await this.#resolve()
      }
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.#working = false
    }
  }

  // On-demand, ungated resolution pass. Like boss.supervise(), it is callable whether or not the
  // background poll is running, so tests and apps can resolve flows deterministically. It skips
  // the version-table cadence gate but still serializes against an in-flight poll via #working.
  async resolveNow (): Promise<void> {
    while (this.#working) {
      await delay(10)
    }

    if (this.#stopping) return

    this.#working = true

    try {
      await this.#resolve()
    } finally {
      this.#working = false
    }
  }

  async #resolve (): Promise<void> {
    const queues = await this.#manager.getQueues()

    // Group queues by partition table so each audit statement targets a single table and prunes to
    // the chunk's queue names (mirrors boss.supervise()'s grouping).
    const queueGroups = queues.reduce<Record<string, { table: string, names: string[] }>>((acc, q) => {
      acc[q.table] = acc[q.table] || { table: q.table, names: [] }
      acc[q.table].names.push(q.name)
      return acc
    }, {})

    for (const group of Object.values(queueGroups)) {
      if (this.#stopping) return

      const { table } = group
      const names = [...group.names]

      while (names.length) {
        if (this.#stopping) return

        const chunk = names.splice(0, 100)

        let batches = 0
        let resolved = 0

        do {
          if (this.#stopping) return

          resolved = this.#config.noMultiMutationCte
            ? await this.#manager.resolveFlowJobsDistributed(table, chunk)
            : await this.#resolveStandard(table, chunk)

          if (resolved > 0) {
            this.emit(events.flow, { table, resolved })
          }
        } while (resolved >= plans.FLOW_BATCH_SIZE && ++batches < MAX_BATCHES_PER_PASS && !this.#stopping)
      }
    }
  }

  async #resolveStandard (table: string, names: string[]): Promise<number> {
    const query = plans.resolveFlowJobs(this.#config.schema, table, names)
    const { rows } = await this.#db.executeSql(query.text, query.values)
    // CockroachDB returns integer columns as strings; coerce so the drain-loop comparison is numeric.
    return Number(rows[0]?.resolved ?? 0)
  }
}

export default Navigator
