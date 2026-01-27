/**
 * Initialize development database with pg-boss schema and test queues
 */
import { setTimeout } from 'node:timers/promises'
import { PgBoss } from '../../../src/index.ts'

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/pgboss'
const schema = process.env.PGBOSS_SCHEMA || 'pgboss'

async function main () {
  console.log(`Initializing pg-boss schema "${schema}"...`)

  const boss = new PgBoss({
    connectionString,
    schema,
    supervise: true,
    superviseIntervalSeconds: 1, // Fast supervisor loop for dev setup
    monitorIntervalSeconds: 1, // Fast monitoring for dev setup
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
    { name: 'tenant-jobs', options: { policy: 'standard' } },
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

  // Add grouped jobs (jobs belonging to different tenants/groups)
  await boss.send('tenant-jobs', { action: 'sync-users' }, { group: { id: 'tenant-acme' } })
  await boss.send('tenant-jobs', { action: 'sync-products' }, { group: { id: 'tenant-acme' } })
  await boss.send('tenant-jobs', { action: 'generate-invoice' }, { group: { id: 'tenant-acme', tier: 'premium' } })
  await boss.send('tenant-jobs', { action: 'sync-users' }, { group: { id: 'tenant-globex' } })
  await boss.send('tenant-jobs', { action: 'sync-inventory' }, { group: { id: 'tenant-globex', tier: 'standard' } })
  await boss.send('tenant-jobs', { action: 'backup-data' }, { group: { id: 'tenant-initech', tier: 'basic' } })

  console.log('  Added sample jobs to queues (including grouped jobs)')

  // Wait for monitor to update queue stats (monitor runs every 1s, need at least one cycle)
  console.log('  Waiting for stats to update...')
  await setTimeout(3000)

  await boss.stop()

  console.log('Done! Run `npm run dev` to start the dashboard.')
}

main().catch((err) => {
  console.error('Failed to initialize:', err.message)
  process.exit(1)
})
