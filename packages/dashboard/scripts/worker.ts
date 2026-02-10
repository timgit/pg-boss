import { PgBoss } from 'pg-boss'

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/pgboss'
const schema = process.env.PGBOSS_SCHEMA || 'pgboss'

async function main () {
  console.log(`Starting pg-boss worker on schema "${schema}"...`)

  const boss = new PgBoss({
    connectionString,
    schema,
  })

  boss.on('error', (err) => console.error('pg-boss error:', err.message))

  await boss.start()
  console.log('Worker started successfully')

  // Register work handlers for common queues
  // These are example handlers - customize based on your needs

  await boss.work('email-notifications', async ([job]) => {
    console.log(`[email-notifications] Processing job ${job.id}:`, job.data)
    // Simulate email sending
    await new Promise(resolve => setTimeout(resolve, 1000))
    console.log(`[email-notifications] Job ${job.id} completed`)
  })

  await boss.work('payment-processing', async ([job]) => {
    console.log(`[payment-processing] Processing job ${job.id}:`, job.data)
    // Simulate payment processing
    await new Promise(resolve => setTimeout(resolve, 2000))
    console.log(`[payment-processing] Job ${job.id} completed`)
  })

  await boss.work('report-generation', async ([job]) => {
    console.log(`[report-generation] Processing job ${job.id}:`, job.data)
    // Simulate report generation
    await new Promise(resolve => setTimeout(resolve, 3000))
    console.log(`[report-generation] Job ${job.id} completed`)
  })

  await boss.work('user-sync', async ([job]) => {
    console.log(`[user-sync] Processing job ${job.id}:`, job.data)
    // Simulate user sync
    await new Promise(resolve => setTimeout(resolve, 1500))
    console.log(`[user-sync] Job ${job.id} completed`)
  })

  await boss.work('cleanup-tasks', async ([job]) => {
    console.log(`[cleanup-tasks] Processing job ${job.id}:`, job.data)
    // Simulate cleanup
    await new Promise(resolve => setTimeout(resolve, 500))
    console.log(`[cleanup-tasks] Job ${job.id} completed`)
  })

  await boss.work('tenant-jobs', async ([job]) => {
    console.log(`[tenant-jobs] Processing job ${job.id} for group ${job.groupId}:`, job.data)
    // Simulate tenant-specific work
    await new Promise(resolve => setTimeout(resolve, 1000))
    console.log(`[tenant-jobs] Job ${job.id} completed`)
  })

  console.log('Work handlers registered. Worker is now processing jobs...')
  console.log('Press Ctrl+C to stop')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`)
    try {
      await boss.stop()
      console.log('Worker stopped successfully')
      process.exit(0)
    } catch (err) {
      console.error('Error during shutdown:', err)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('Failed to start worker:', err.message)
  process.exit(1)
})
