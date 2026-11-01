/** The changes the free job page makes to one job. Deleting, sending and everything over many jobs are Pro's. */
export const JOB_INTENTS = ['retry', 'cancel', 'resume'] as const
export type JobIntent = (typeof JOB_INTENTS)[number]

export function isJobIntent (intent: unknown): intent is JobIntent {
  return typeof intent === 'string' && JOB_INTENTS.includes(intent as JobIntent)
}

/** What the page shows after a change: done, or why nothing changed. */
export interface JobActionResult {
  success: boolean
  message: string
}
