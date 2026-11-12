import { PgBoss } from 'pg-boss'
import type { JobActionResult, JobIntent } from './job-actions'

const DONE: Record<JobIntent, string> = {
  retry: 'Job queued for retry',
  cancel: 'Job cancelled',
  resume: 'Job resumed',
}

const UNCHANGED: Record<JobIntent, string> = {
  retry: 'Job could not be retried (only failed jobs can be retried)',
  cancel: 'Job could not be cancelled (it may already be completed or cancelled)',
  resume: 'Job could not be resumed (only cancelled jobs can be resumed)',
}

/**
 * Retries, cancels or resumes one job through pg-boss itself, never an UPDATE of the dashboard's
 * own: retry() adds an attempt to the limit and keeps started_on, so the attempt numbers stay right.
 *
 * An instance per change, started and stopped around the one call, so the dashboard keeps no
 * pg-boss running and leaves no row in the instance registry.
 */
export async function runJobAction (
  dbUrl: string,
  schema: string,
  name: string,
  id: string,
  intent: JobIntent
): Promise<JobActionResult> {
  const boss = new PgBoss({
    connectionString: dbUrl,
    schema,
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    max: 1,
    registerInstance: false,
  })

  boss.on('error', (error) => console.error('pg-boss dashboard: a pg-boss instance hit an error.', error))

  try {
    try {
      await boss.start()
    } catch (error) {
      // pg-boss refuses to start on any schema version but its own.
      if (error instanceof Error && /requires migrations/.test(error.message)) {
        return {
          success: false,
          message: "This schema is on a different version than the dashboard's pg-boss is built for. Run the dashboard with the pg-boss version your application uses.",
        }
      }
      throw error
    }

    const response = intent === 'retry'
      ? await boss.retry(name, id)
      : intent === 'cancel'
        ? await boss.cancel(name, id)
        : await boss.resume(name, id)

    const affected = (response as { affected: number }).affected

    return affected > 0
      ? { success: true, message: DONE[intent] }
      : { success: false, message: UNCHANGED[intent] }
  } finally {
    await boss.stop({ graceful: false }).catch(() => {})
  }
}
