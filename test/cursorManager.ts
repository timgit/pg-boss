import { QUEUES } from '../src/timekeeper.ts'

/**
 * The manager calls a cron pass makes, over a model of the cron statement. A schedule claims when
 * its cursor is behind `through`, and only the jobs after the cursor it replaced go in. Unset
 * cursors read as NULL.
 *
 * `inserted` gets the completed send-it rows a minute-precision job leaves for the rolling-upgrade
 * bridge, with `__singletonSlot` naming their slot as the send-it jobs of earlier releases did.
 * `sent` gets the schedules' own jobs.
 */
export function cursorManager (inserted: any[] = [], sent: any[] = []) {
  const cursors = new Map<string, number | null>()

  const manager = {
    getQueueCache: async () => ({ notify: false }),
    scheduledJobFields: (name: string, data: unknown, options: object) => ({ ...options, name, data }),
    // send-it holds nothing for the pass to drain.
    fetch: async () => [],
    complete: async () => {},
    send: async () => null,
    sendScheduled: async (_count: number, build: (traceContext: null) => { values: unknown[] }) => {
      const { values } = build(null)
      const payload = JSON.parse(values[0] as string)
      const jobs = JSON.parse(values[1] as string)
      const rows: any[] = []

      for (const schedule of payload) {
        const id = JSON.stringify([schedule.name, schedule.key])
        const prev = cursors.get(id) ?? null
        const through = Date.parse(schedule.through)
        const claimed = prev === null || prev < through

        rows.push({ name: schedule.name, key: schedule.key, prev: prev === null ? null : new Date(prev), claimed, id: null })

        if (!claimed) continue

        cursors.set(id, through)

        for (const job of jobs) {
          if ((job.scheduleName ?? job.name) !== schedule.name || job.scheduleKey !== schedule.key) continue
          if (prev !== null && Date.parse(job.occurrence) <= prev) continue

          if (job.name === QUEUES.SEND_IT) {
            inserted.push({ ...job, __singletonSlot: job.bridgeSlot })
          } else {
            sent.push(job)
            rows.push({ name: job.name, id: job.id, inserted: true })
          }
        }
      }

      return rows
    }
  }

  return { manager, cursors, inserted, sent }
}
