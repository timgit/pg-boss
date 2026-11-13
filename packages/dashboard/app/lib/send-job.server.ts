import type { SendRequest } from './send-form'
import { SchemaVersionMismatch, withBoss } from './pg-boss.server'

export type SendResult = { jobId: string } | { error: string }

/**
 * Sends one job through `boss.send()`. pg-boss returns no id when the queue's policy or a singleton
 * key keeps the job from being created, and that is said rather than taken for success.
 */
export async function sendJob (dbUrl: string, schema: string, { queue, data, options }: SendRequest): Promise<SendResult> {
  try {
    const jobId = await withBoss(dbUrl, schema, (boss) => boss.send(queue, data, options))

    return jobId
      ? { jobId }
      : { error: 'pg-boss didn\'t create the job. A job with the same singleton key may already exist, or the queue\'s policy kept it out.' }
  } catch (error) {
    if (error instanceof SchemaVersionMismatch) return { error: error.message }
    return { error: `Failed to send job: ${error instanceof Error ? error.message : String(error)}` }
  }
}
