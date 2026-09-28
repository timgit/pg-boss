import { PgBoss } from 'pg-boss'
import type { JobWithMetadata } from './types'

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

  // Without a listener, a dropped connection throws and takes the process down.
  boss.on('error', (err) => {
    console.error('Unexpected pg-boss error:', err)
  })

  const startPromise = boss.start().then(() => {
    instances.set(key, boss)
    starting.delete(key)
    return boss
  }).catch(async (err) => {
    starting.delete(key)
    // start() opens its pool before it can fail.
    await boss.stop({ graceful: false }).catch(() => {})
    throw err
  })

  starting.set(key, startPromise)

  return startPromise
}

// Each instance keeps a timer alive. Reached by an embedding host's `close()`, from another bundle.
export async function stopAllInstances (): Promise<void> {
  while (starting.size > 0) {
    await Promise.allSettled([...starting.values()])
  }

  const started = [...instances.values()]
  instances.clear()

  await Promise.allSettled(started.map(boss => boss.stop({ graceful: false })))
}

const STOP_INSTANCES_KEY = Symbol.for('pgboss.dashboard.stopAllInstances')
const globalStore = globalThis as typeof globalThis & { [STOP_INSTANCES_KEY]?: () => Promise<void> }

globalStore[STOP_INSTANCES_KEY] = stopAllInstances

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
