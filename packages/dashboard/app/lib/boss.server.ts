import { PgBoss } from 'pg-boss'
import type { SendOptions, ScheduleOptions, JobWithMetadata } from './types'

// Cache pg-boss instances by connection string + schema
const instances = new Map<string, PgBoss>()
const starting = new Map<string, Promise<PgBoss>>()

function getCacheKey (dbUrl: string, schema: string): string {
  return `${dbUrl}::${schema}`
}

async function getInstance (dbUrl: string, schema: string): Promise<PgBoss> {
  const key = getCacheKey(dbUrl, schema)

  const existing = instances.get(key)
  if (existing) {
    return existing
  }

  // Avoid concurrent start() calls for the same instance
  const pending = starting.get(key)
  if (pending) {
    return pending
  }

  const boss = new PgBoss({
    connectionString: dbUrl,
    schema,
    schedule: false,
    supervise: false,
    migrate: false,
    createSchema: false,
  })

  const startPromise = boss.start().then(() => {
    instances.set(key, boss)
    starting.delete(key)
    return boss
  }).catch((err) => {
    starting.delete(key)
    throw err
  })

  starting.set(key, startPromise)

  return startPromise
}

export async function sendJob (
  dbUrl: string,
  schema: string,
  queueName: string,
  data: object | null,
  options?: SendOptions
): Promise<string | null> {
  const boss = await getInstance(dbUrl, schema)
  return boss.send(queueName, data, options)
}

export async function schedule (
  dbUrl: string,
  schema: string,
  name: string,
  cron: string,
  data?: object,
  options?: ScheduleOptions
): Promise<void> {
  const boss = await getInstance(dbUrl, schema)
  return boss.schedule(name, cron, data, options)
}

export async function unschedule (
  dbUrl: string,
  schema: string,
  name: string,
  key?: string
): Promise<void> {
  const boss = await getInstance(dbUrl, schema)
  return boss.unschedule(name, key)
}

export async function getJobById<T = object> (
  dbUrl: string,
  schema: string,
  name: string,
  id: string
): Promise<JobWithMetadata<T> | null> {
  const boss = await getInstance(dbUrl, schema)
  const [job] = await boss.findJobs<T>(name, { id })
  return job ?? null
}

export async function cancelJob (
  dbUrl: string,
  schema: string,
  name: string,
  id: string | string[]
): Promise<number> {
  const boss = await getInstance(dbUrl, schema)
  const result = await boss.cancel(name, id) as any
  return result.affected
}

export async function resumeJob (
  dbUrl: string,
  schema: string,
  name: string,
  id: string | string[]
): Promise<number> {
  const boss = await getInstance(dbUrl, schema)
  const result = await boss.resume(name, id) as any
  return result.affected
}

export async function deleteJob (
  dbUrl: string,
  schema: string,
  name: string,
  id: string | string[]
): Promise<number> {
  const boss = await getInstance(dbUrl, schema)

  // Check if job(s) are active - don't delete active jobs
  const ids = Array.isArray(id) ? id : [id]
  const deletableIds: string[] = []

  // Check each job individually
  for (const jobId of ids) {
    const [job] = await boss.findJobs(name, { id: jobId })
    // Only add to deletableIds if job exists and is not active
    if (job && job.state !== 'active') {
      deletableIds.push(jobId)
    }
  }

  if (deletableIds.length === 0) {
    return 0
  }

  const result = await boss.deleteJob(name, deletableIds.length === 1 ? deletableIds[0] : deletableIds) as any
  return result.affected
}

export async function createQueue (
  dbUrl: string,
  schema: string,
  queueName: string,
  options?: Record<string, any>
): Promise<void> {
  const boss = await getInstance(dbUrl, schema)
  return boss.createQueue(queueName, options)
}
