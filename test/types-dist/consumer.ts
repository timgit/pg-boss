import { PgBoss, TestClock, type Job, type WorkHandler } from '../../dist/index.js'

export const boss = new PgBoss({ connectionString: 'postgres://localhost/pgboss' })

export const clock = new TestClock()

export const handler: WorkHandler<{ id: string }> = async (jobs: Job<{ id: string }>[]) => {
  await boss.complete('queue', jobs.map(job => job.id))
}
