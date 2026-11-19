import { resolveSchemaHref } from '~/lib/schema-href'
import type { PublishRequest } from './publish-form'
import { getSubscription } from './queries.server'
import { SchemaVersionMismatch, withBoss } from './pg-boss.server'

export type PublishResult = { queues: string[] } | { error: string }

/** pg-boss's refusal as one sentence, with each queue's own reason when several sends failed. */
export function publishFailure (error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return `${error.message}: ${error.errors.map(String).join('; ')}`
  }

  return error instanceof Error ? error.message : String(error)
}

/**
 * Publishes an event through `boss.publish()`, which sends one job to each queue subscribed to it.
 * An event no queue is subscribed to is refused, since publishing it would send nothing.
 */
export async function publishEvent (dbUrl: string, schema: string, { event, data, options }: PublishRequest): Promise<PublishResult> {
  const queues = (await getSubscription(dbUrl, schema, event)).map((queue) => queue.name)
  if (queues.length === 0) return { error: `No queue is subscribed to ${event}, so publishing it would send nothing.` }

  try {
    await withBoss(dbUrl, schema, (boss) => boss.publish(event, data ?? undefined, options))
    return { queues }
  } catch (error) {
    if (error instanceof SchemaVersionMismatch) return { error: error.message }
    return { error: `Failed to publish: ${publishFailure(error)}` }
  }
}

/** The Jobs page on the queues an event was published to, where its jobs are. */
export function publishedJobsHref (queues: string[], schema: string | null): string {
  return resolveSchemaHref(`/jobs?${new URLSearchParams({ queues: queues.join(',') })}`, schema)
}
