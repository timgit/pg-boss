import { PgBoss } from 'pg-boss'
import type { SendOptions, ScheduleOptions } from 'pg-boss'

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
  data: object,
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
