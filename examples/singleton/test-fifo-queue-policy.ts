import { PgBoss } from '../../dist/index.js'

function getQueueName () {
  return `fifo-test-${Date.now()}-${Math.random().toString(36).substring(7)}`
}

interface TestJob {
  testId: string
  messageNum: number
  shouldFail?: boolean
}

async function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface TestResult {
  config: string
  expectedOrder: number[]
  actualOrder: number[]
  passed: boolean
  description: string
}

async function runFifoTest (
  boss: PgBoss,
  testConfig: {
    name: string
    description: string
    useFifoQueue: boolean
    sendOptions: (num: number) => any
    workOptions: any
    expectedToPass: boolean
  }
): Promise<TestResult> {
  const queueName = getQueueName()
  const testId = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`
  const actualOrder: number[] = []
  const expectedOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  let resolveCompletion!: () => void
  const completionPromise = new Promise<void>(resolve => {
    resolveCompletion = resolve
  })

  console.log(`\n${'='.repeat(70)}`)
  console.log(`Running test: ${testConfig.name}`)
  console.log(`Description: ${testConfig.description}`)
  console.log('='.repeat(70))

  // Create queue - either FIFO or standard
  if (testConfig.useFifoQueue) {
    await boss.createQueue(queueName, { policy: 'singleton_strict_fifo' })
    console.log('Created FIFO queue')
  } else {
    await boss.createQueue(queueName)
    console.log('Created standard queue')
  }

  // Send 10 jobs FIRST (before starting worker)
  console.log('Sending 10 jobs rapidly...')
  for (let i = 1; i <= 10; i++) {
    await boss.send(
      queueName,
      { testId, messageNum: i },
      testConfig.sendOptions(i)
    )
    console.log(`  Queued message ${i}`)
  }

  // Small delay to ensure all jobs are committed
  await sleep(100)

  // THEN start worker that records execution order
  console.log('Starting worker...')
  await boss.work<TestJob>(
    queueName,
    testConfig.workOptions,
    async (jobs) => {
      for (const job of jobs) {
        if (job.data.testId === testId) {
          console.log(`  Processing message ${job.data.messageNum}`)
          actualOrder.push(job.data.messageNum)
          await sleep(50) // Small processing time

          // Check if we've processed all 10 jobs
          if (actualOrder.length === 10) {
            resolveCompletion()
          }
        } else {
          console.log('  [STALE] Skipping job with different testId')
        }
      }
    }
  )

  // Wait for all jobs to complete or timeout
  console.log('Waiting for jobs to complete...')
  const timeoutPromise = sleep(30000)
  await Promise.race([completionPromise, timeoutPromise])

  await sleep(200)
  await boss.offWork(queueName)

  const passed = JSON.stringify(actualOrder) === JSON.stringify(expectedOrder)
  const result: TestResult = {
    config: testConfig.name,
    expectedOrder,
    actualOrder,
    passed,
    description: testConfig.description
  }

  const statusEmoji = passed === testConfig.expectedToPass ? '✅' : '❌'
  console.log(`\nResult: ${statusEmoji} ${passed ? 'FIFO ORDER' : 'NOT FIFO ORDER'} (expected: ${testConfig.expectedToPass ? 'FIFO' : 'NOT FIFO'})`)
  console.log(`Expected order: [${expectedOrder.join(', ')}]`)
  console.log(`Actual order:   [${actualOrder.join(', ')}]`)

  return result
}

async function runRetryBlockingTest (boss: PgBoss): Promise<void> {
  const queueName = getQueueName()
  console.log(`\n${'='.repeat(70)}`)
  console.log('Running test: FIFO retry blocking')
  console.log('Description: Verifies queue blocks during retry')
  console.log('='.repeat(70))

  await boss.createQueue(queueName, { policy: 'singleton_strict_fifo' })

  const processedOrder: number[] = []
  const testId = `retry-test-${Date.now()}`
  let failCount = 0

  // Send 3 jobs - first one will fail once then succeed
  for (let i = 1; i <= 3; i++) {
    await boss.send(queueName, { testId, messageNum: i }, {
      singletonKey: 'retry-test',
      retryLimit: 2,
      retryDelay: 1 // 1 second retry delay
    })
    console.log(`  Queued message ${i}`)
  }

  let resolveCompletion!: () => void
  const completionPromise = new Promise<void>(resolve => {
    resolveCompletion = resolve
  })

  await boss.work<TestJob>(
    queueName,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        if (job.data.testId !== testId) continue

        console.log(`  Processing message ${job.data.messageNum} (attempt)`)

        // First job fails on first attempt
        if (job.data.messageNum === 1 && failCount === 0) {
          failCount++
          console.log('  -> FAILING message 1 (will retry)')
          throw new Error('Simulated failure')
        }

        processedOrder.push(job.data.messageNum)
        console.log(`  -> SUCCESS message ${job.data.messageNum}`)

        if (processedOrder.length === 3) {
          resolveCompletion()
        }
      }
    }
  )

  await Promise.race([completionPromise, sleep(10000)])
  await boss.offWork(queueName)

  const expectedOrder = [1, 2, 3]
  const passed = JSON.stringify(processedOrder) === JSON.stringify(expectedOrder)

  console.log(`\nResult: ${passed ? '✅ PASSED' : '❌ FAILED'}`)
  console.log(`Expected: [${expectedOrder.join(', ')}]`)
  console.log(`Actual:   [${processedOrder.join(', ')}]`)
  console.log('Note: Message 1 should retry and complete before 2 and 3 process')
}

async function runParallelSingletonKeysTest (boss: PgBoss): Promise<void> {
  const queueName = getQueueName()
  console.log(`\n${'='.repeat(70)}`)
  console.log('Running test: Parallel processing of different singletonKeys')
  console.log('Description: Different singletonKeys should process in parallel')
  console.log('='.repeat(70))

  await boss.createQueue(queueName, { policy: 'singleton_strict_fifo' })

  const processedJobs: { key: string, num: number, time: number }[] = []
  const testId = `parallel-test-${Date.now()}`
  const startTime = Date.now()

  // Send jobs for two different singletonKeys
  for (let i = 1; i <= 3; i++) {
    await boss.send(queueName, { testId, messageNum: i }, { singletonKey: 'key-A' })
    await boss.send(queueName, { testId, messageNum: i }, { singletonKey: 'key-B' })
  }
  console.log('  Queued 3 jobs for key-A and 3 jobs for key-B')

  let resolveCompletion!: () => void
  const completionPromise = new Promise<void>(resolve => {
    resolveCompletion = resolve
  })

  await boss.work<TestJob>(
    queueName,
    { batchSize: 2, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        if (job.data.testId !== testId) continue

        const metadata = job as any
        const key = metadata.singletonKey
        const elapsed = Date.now() - startTime

        console.log(`  Processing ${key} message ${job.data.messageNum} at ${elapsed}ms`)
        processedJobs.push({ key, num: job.data.messageNum, time: elapsed })

        await sleep(100) // Processing time

        if (processedJobs.length === 6) {
          resolveCompletion()
        }
      }
    }
  )

  await Promise.race([completionPromise, sleep(10000)])
  await boss.offWork(queueName)

  // Check FIFO order within each key
  const keyAOrder = processedJobs.filter(j => j.key === 'key-A').map(j => j.num)
  const keyBOrder = processedJobs.filter(j => j.key === 'key-B').map(j => j.num)

  const keyAFifo = JSON.stringify(keyAOrder) === JSON.stringify([1, 2, 3])
  const keyBFifo = JSON.stringify(keyBOrder) === JSON.stringify([1, 2, 3])

  console.log('\nResult:')
  console.log(`  key-A FIFO: ${keyAFifo ? '✅' : '❌'} [${keyAOrder.join(', ')}]`)
  console.log(`  key-B FIFO: ${keyBFifo ? '✅' : '❌'} [${keyBOrder.join(', ')}]`)
  console.log(`  Overall: ${keyAFifo && keyBFifo ? '✅ PASSED' : '❌ FAILED'}`)
}

async function runBlockedKeysTest (boss: PgBoss): Promise<void> {
  const queueName = getQueueName()
  console.log(`\n${'='.repeat(70)}`)
  console.log('Running test: getBlockedKeys API')
  console.log('Description: Verifies blocked keys can be queried')
  console.log('='.repeat(70))

  await boss.createQueue(queueName, { policy: 'singleton_strict_fifo' })

  const testId = `blocked-test-${Date.now()}`

  // Send a job that will fail permanently
  await boss.send(queueName, { testId, messageNum: 1, shouldFail: true }, {
    singletonKey: 'will-block',
    retryLimit: 0 // No retries - will fail permanently
  })

  // Send another job for a different key
  await boss.send(queueName, { testId, messageNum: 2 }, {
    singletonKey: 'will-succeed',
    retryLimit: 0
  })

  let failedJobId: string | null = null

  await boss.work<TestJob>(
    queueName,
    { batchSize: 1, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) {
        if (job.data.testId !== testId) continue

        if (job.data.shouldFail) {
          failedJobId = job.id
          console.log(`  Failing job ${job.data.messageNum} (singletonKey: will-block)`)
          throw new Error('Intentional failure')
        }
        console.log(`  Completed job ${job.data.messageNum} (singletonKey: will-succeed)`)
      }
    }
  )

  // Wait for jobs to be processed
  await sleep(2000)
  await boss.offWork(queueName)

  // Check blocked keys
  const blockedKeys = await boss.getBlockedKeys(queueName)
  console.log(`\nBlocked keys: [${blockedKeys.join(', ')}]`)

  const hasBlockedKey = blockedKeys.includes('will-block')
  console.log(`Result: ${hasBlockedKey ? '✅ PASSED' : '❌ FAILED'} - will-block is ${hasBlockedKey ? '' : 'NOT '}in blocked keys`)

  // Demonstrate unblocking by deleting the failed job
  if (failedJobId) {
    console.log('\nUnblocking by deleting failed job...')
    await boss.deleteJob(queueName, failedJobId)

    const blockedKeysAfter = await boss.getBlockedKeys(queueName)
    console.log(`Blocked keys after delete: [${blockedKeysAfter.join(', ')}]`)
    console.log(`Unblock result: ${blockedKeysAfter.length === 0 ? '✅ PASSED' : '❌ FAILED'}`)
  }
}

async function main () {
  const boss = new PgBoss('postgres://postgres:postgres@localhost/pgboss')
  boss.on('error', console.error)

  await boss.start()

  const results: TestResult[] = []

  // Test 1: Standard queue (no FIFO) - should NOT maintain order with concurrent workers
  results.push(await runFifoTest(boss, {
    name: 'standard-queue-concurrent',
    description: 'Standard queue with concurrent workers - NO FIFO guarantee',
    useFifoQueue: false,
    sendOptions: (_num) => ({}),
    workOptions: {
      batchSize: 1,
      localConcurrency: 4
    },
    expectedToPass: false // Standard queue doesn't guarantee FIFO
  }))

  // Test 2: FIFO queue with single worker - should maintain order
  results.push(await runFifoTest(boss, {
    name: 'fifo-queue-single-worker',
    description: 'FIFO queue with single worker - strict FIFO order',
    useFifoQueue: true,
    sendOptions: (_num) => ({ singletonKey: 'workflow-A' }),
    workOptions: {
      batchSize: 1,
      localConcurrency: 1
    },
    expectedToPass: true
  }))

  // Test 3: FIFO queue with multiple workers - should still maintain order
  // because the index enforces only one active job per singletonKey
  results.push(await runFifoTest(boss, {
    name: 'fifo-queue-multi-worker',
    description: 'FIFO queue with multiple workers - still FIFO due to index constraint',
    useFifoQueue: true,
    sendOptions: (_num) => ({ singletonKey: 'workflow-A' }),
    workOptions: {
      batchSize: 1,
      localConcurrency: 4
    },
    expectedToPass: true
  }))

  // Test 4: Retry blocking test
  await runRetryBlockingTest(boss)

  // Test 5: Parallel singletonKeys test
  await runParallelSingletonKeysTest(boss)

  // Test 6: Blocked keys API test
  await runBlockedKeysTest(boss)

  await boss.stop()

  // Print summary
  console.log('\n' + '='.repeat(70))
  console.log('TEST SUMMARY')
  console.log('='.repeat(70))

  results.forEach((result, index) => {
    console.log(`\nTest ${index + 1}: ${result.config}`)
    console.log(`Description: ${result.description}`)
    console.log(`FIFO Order: ${result.passed ? '✅ YES' : '❌ NO'}`)
  })

  console.log('\n' + '='.repeat(70))
  console.log('FIFO QUEUE POLICY BENEFITS:')
  console.log('='.repeat(70))
  console.log('1. Strict FIFO ordering per singletonKey')
  console.log('2. Queue blocks during retry - next job waits')
  console.log('3. Queue blocks on permanent failure until manual intervention')
  console.log('4. Different singletonKeys process in parallel')
  console.log('5. getBlockedKeys() API to find blocked sequences')
  console.log('6. Use deleteJob() or retry() to unblock')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
