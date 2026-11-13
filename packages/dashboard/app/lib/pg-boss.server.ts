import { PgBoss } from 'pg-boss'

/** pg-boss refuses to start on any schema version but its own. */
export class SchemaVersionMismatch extends Error {
  override name = 'SchemaVersionMismatch'

  constructor () {
    super("This schema is on a different version than the dashboard's pg-boss is built for. Run the dashboard with the pg-boss version your application uses.")
  }
}

/**
 * Runs `work` on a pg-boss instance started for it and stopped after, so the dashboard keeps no
 * pg-boss running and leaves no row in the instance registry. Every change the dashboard makes goes
 * through pg-boss's own API this way, never through SQL of the dashboard's own. Throws
 * `SchemaVersionMismatch` when the schema isn't on this pg-boss's version.
 */
export async function withBoss<T> (dbUrl: string, schema: string, work: (boss: PgBoss) => Promise<T>): Promise<T> {
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
      if (error instanceof Error && /requires migrations/.test(error.message)) throw new SchemaVersionMismatch()
      throw error
    }

    return await work(boss)
  } finally {
    await boss.stop({ graceful: false }).catch(() => {})
  }
}
