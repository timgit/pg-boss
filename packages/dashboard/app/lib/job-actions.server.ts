import type { JobActionResult, JobIntent } from './job-actions'
import { SchemaVersionMismatch, withBoss } from './pg-boss.server'

const DONE: Record<JobIntent, string> = {
  retry: 'Job queued for retry',
  cancel: 'Job cancelled',
  resume: 'Job resumed',
  delete: 'Job deleted',
}

const UNCHANGED: Record<JobIntent, string> = {
  retry: 'Job could not be retried (only failed jobs can be retried)',
  cancel: 'Job could not be cancelled (it may already be completed or cancelled)',
  resume: 'Job could not be resumed (only cancelled jobs can be resumed)',
  delete: 'Job could not be deleted (it may already be deleted)',
}

/**
 * Retries, cancels, resumes or deletes one job through pg-boss itself: retry() adds an attempt to
 * the limit and keeps started_on, so the attempt numbers stay right.
 */
export async function runJobAction (
  dbUrl: string,
  schema: string,
  name: string,
  id: string,
  intent: JobIntent
): Promise<JobActionResult> {
  let affected: number

  try {
    affected = await withBoss(dbUrl, schema, async (boss) => {
      const response = intent === 'retry'
        ? await boss.retry(name, id)
        : intent === 'cancel'
          ? await boss.cancel(name, id)
          : intent === 'resume'
            ? await boss.resume(name, id)
            : await boss.deleteJob(name, id)

      return (response as { affected: number }).affected
    })
  } catch (error) {
    if (error instanceof SchemaVersionMismatch) return { success: false, message: error.message }
    throw error
  }

  return affected > 0
    ? { success: true, message: DONE[intent] }
    : { success: false, message: UNCHANGED[intent] }
}
