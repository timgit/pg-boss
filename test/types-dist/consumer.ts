import { PgBoss, TestClock, type Job, type WorkHandler } from '../../dist/index.js'

export const boss = new PgBoss({ connectionString: 'postgres://localhost/pgboss' })

export const clock = new TestClock()

export const handler: WorkHandler<{ id: string }> = async (jobs: Job<{ id: string }>[]) => {
  await boss.complete('queue', jobs.map(job => job.id))
}

// The documented check for a lapsed claim reads these fields, so stripping them breaks consumers (#998).
export async function settle (job: Job): Promise<boolean> {
  const { jobs, requested, affected, settled } = await boss.complete('queue', job)
  return jobs.length === requested && affected === requested && (settled ?? []).length === affected
}

// The documented catch block passes the caught value, which strict mode types as unknown (#1000).
export async function failCaught (job: Job, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    await boss.fail('queue', job, err)
  }
}
