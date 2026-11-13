/** The changes the job page makes to one job. Creating queues, schedules and everything over many jobs are Pro's. */
export const JOB_INTENTS = ['retry', 'cancel', 'resume', 'delete'] as const
export type JobIntent = (typeof JOB_INTENTS)[number]

export function isJobIntent (intent: unknown): intent is JobIntent {
  return typeof intent === 'string' && JOB_INTENTS.includes(intent as JobIntent)
}

/** What the page shows after a change: done, or why nothing changed. */
export interface JobActionResult {
  success: boolean
  message: string
}

/**
 * The job page's changes that apply to a job in `state`. pg-boss deletes an active job too, but a
 * worker still holds it, so the page offers delete only once the job isn't running.
 */
export function jobVerbs (state: string) {
  return {
    retry: state === 'failed',
    resume: state === 'cancelled',
    cancel: state === 'created' || state === 'retry' || state === 'active',
    remove: state !== 'active',
  }
}
