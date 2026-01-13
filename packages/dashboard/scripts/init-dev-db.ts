/**
 * Initialize development database with pg-boss schema and test queues
 */
import { PgBoss } from '../../../src/index.ts'

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/pgboss'
const schema = process.env.PGBOSS_SCHEMA || 'pgboss'

async function main () {
  console.log(`Initializing pg-boss schema "${schema}"...`)

  const boss = new PgBoss({
    connectionString,
    schema,
  })

  boss.on('error', (err) => console.error('pg-boss error:', err.message))

  await boss.start()

  // Create test queues with different policies
  const queues = [
    { name: 'email-notifications', options: { policy: 'standard' } },
    { name: 'payment-processing', options: { policy: 'standard', retryLimit: 5 } },
    { name: 'report-generation', options: { policy: 'singleton' } },
    { name: 'user-sync', options: { policy: 'stately' } },
    { name: 'cleanup-tasks', options: { policy: 'short', expireInSeconds: 60 } },
  ]

  for (const { name, options } of queues) {
    await boss.createQueue(name, options)
    console.log(`  Created queue: ${name} (${options.policy})`)
  }

  // Add some sample jobs
  await boss.send('email-notifications', { to: 'user@example.com', subject: 'Welcome!' })
  await boss.send('email-notifications', { to: 'admin@example.com', subject: 'Report ready' })
  await boss.send('payment-processing', { orderId: '12345', amount: 99.99 })
  await boss.send('report-generation', { reportType: 'monthly', month: 'January' })
  await boss.send('cleanup-tasks', { target: 'temp-files' })

  console.log('  Added sample jobs to queues')

  await boss.stop()

  console.log('Done! Run `npm run dev` to start the dashboard.')
}

main().catch((err) => {
  console.error('Failed to initialize:', err.message)
  process.exit(1)
})
