import { describe, it, expect } from 'vitest'
import { ctx, createTestQueue, getBoss } from './helpers'
import { action as sendJobAction } from '~/routes/send'
import { action as createQueueAction } from '~/routes/queues.create'
import { getQueue } from '~/lib/queries.server'

describe('Send Job Action', () => {
  it('creates a job with basic options', async () => {
    await createTestQueue('test-queue')

    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('data', '{"test": "value"}')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    const result = await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    // Should redirect on success
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(302)

    // Verify job was created
    const boss = getBoss()
    const jobs = await boss.findJobs('test-queue')
    expect(jobs).toHaveLength(1)
    expect(jobs[0].data).toEqual({ test: 'value' })
  })

  it('creates a job with priority', async () => {
    await createTestQueue('test-queue')

    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('data', '{"test": "value"}')
    formData.set('priority', '10')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const boss = getBoss()
    const jobs = await boss.findJobs('test-queue')
    expect(jobs[0].priority).toBe(10)
  })

  it('creates a job with startAfter', async () => {
    await createTestQueue('test-queue')

    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('data', '{"test": "value"}')
    formData.set('startAfter', '1 minute')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const boss = getBoss()
    const jobs = await boss.findJobs('test-queue')
    expect(jobs[0].startAfter).toBeInstanceOf(Date)
    expect(jobs[0].startAfter!.getTime()).toBeGreaterThan(Date.now())
  })

  it('creates a job with singletonKey', async () => {
    await createTestQueue('test-queue')

    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('data', '{"test": "value"}')
    formData.set('singletonKey', 'unique-key')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const boss = getBoss()
    const jobs = await boss.findJobs('test-queue')
    expect(jobs[0].singletonKey).toBe('unique-key')
  })

  it('creates a job with retryLimit', async () => {
    await createTestQueue('test-queue')

    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('data', '{"test": "value"}')
    formData.set('retryLimit', '5')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const boss = getBoss()
    const jobs = await boss.findJobs('test-queue')
    expect(jobs[0].retryLimit).toBe(5)
  })

  it('creates a job with expireInSeconds', async () => {
    await createTestQueue('test-queue')

    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('data', '{"test": "value"}')
    formData.set('expireInSeconds', '3600')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const boss = getBoss()
    const jobs = await boss.findJobs('test-queue')
    expect(jobs[0].expireInSeconds).toBe(3600)
  })

  it('returns error for missing queue name', async () => {
    const formData = new FormData()
    formData.set('data', '{"test": "value"}')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    const result = await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    expect(result).toHaveProperty('error', 'Queue name is required')
  })

  it('returns error for invalid JSON data', async () => {
    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('data', '{invalid json}')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    const result = await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    expect(result).toHaveProperty('error', 'Invalid JSON in data payload')
  })

  it('returns error for invalid priority', async () => {
    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('priority', 'not-a-number')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    const result = await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    expect(result).toHaveProperty('error', 'Priority must be an integer')
  })

  it('returns error for invalid retryLimit', async () => {
    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('retryLimit', '-1')

    const request = new Request('http://localhost/send', {
      method: 'POST',
      body: formData,
    })

    const result = await sendJobAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    expect(result).toHaveProperty('error', 'Retry limit must be a non-negative integer')
  })
})

describe('Create Queue Action', () => {
  it('creates a queue with default options', async () => {
    const formData = new FormData()
    formData.set('queueName', 'new-queue')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    const result = await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    // Should redirect on success
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(302)

    // Verify queue was created with default policy
    const queue = await getQueue(ctx.connectionString, ctx.schema, 'new-queue')
    expect(queue).not.toBeNull()
    expect(queue!.name).toBe('new-queue')
    expect(queue!.policy).toBe('standard')
    expect(queue!.partition).toBe(false)
  })

  it('creates a queue with singleton policy', async () => {
    const formData = new FormData()
    formData.set('queueName', 'singleton-queue')
    formData.set('policy', 'singleton')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const queue = await getQueue(ctx.connectionString, ctx.schema, 'singleton-queue')
    expect(queue!.policy).toBe('singleton')
  })

  it('creates a partitioned queue', async () => {
    const formData = new FormData()
    formData.set('queueName', 'partitioned-queue')
    formData.set('partition', 'true')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const queue = await getQueue(ctx.connectionString, ctx.schema, 'partitioned-queue')
    expect(queue!.partition).toBe(true)
  })

  it('creates a queue with dead letter queue', async () => {
    // Create the dead letter queue first
    await createTestQueue('dlq-queue')

    const formData = new FormData()
    formData.set('queueName', 'main-queue')
    formData.set('deadLetter', 'dlq-queue')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const queue = await getQueue(ctx.connectionString, ctx.schema, 'main-queue')
    expect(queue!.deadLetter).toBe('dlq-queue')
  })

  it('creates a queue with warning queue size', async () => {
    const formData = new FormData()
    formData.set('queueName', 'warning-queue')
    formData.set('warningQueueSize', '1000')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const queue = await getQueue(ctx.connectionString, ctx.schema, 'warning-queue')
    expect(queue!.warningQueueSize).toBe(1000)
  })

  it('creates a queue with retry configuration', async () => {
    const formData = new FormData()
    formData.set('queueName', 'retry-queue')
    formData.set('retryLimit', '5')
    formData.set('retryDelay', '30')
    formData.set('retryBackoff', 'true')
    formData.set('retryDelayMax', '3600')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const queue = await getQueue(ctx.connectionString, ctx.schema, 'retry-queue')
    expect(queue!.retryLimit).toBe(5)
    expect(queue!.retryDelay).toBe(30)
    expect(queue!.retryBackoff).toBe(true)
    expect(queue!.retryDelayMax).toBe(3600)
  })

  it('creates a queue with expiration and retention settings', async () => {
    const formData = new FormData()
    formData.set('queueName', 'expiration-queue')
    formData.set('expireInSeconds', '1800')
    formData.set('retentionSeconds', '604800')
    formData.set('deleteAfterSeconds', '259200')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const queue = await getQueue(ctx.connectionString, ctx.schema, 'expiration-queue')
    expect(queue!.expireInSeconds).toBe(1800)
    expect(queue!.retentionSeconds).toBe(604800)
    expect(queue!.deleteAfterSeconds).toBe(259200)
  })

  it('creates a queue with all options combined', async () => {
    await createTestQueue('dlq')

    const formData = new FormData()
    formData.set('queueName', 'full-config-queue')
    formData.set('policy', 'stately')
    formData.set('partition', 'true')
    formData.set('deadLetter', 'dlq')
    formData.set('warningQueueSize', '500')
    formData.set('retryLimit', '3')
    formData.set('retryDelay', '60')
    formData.set('retryBackoff', 'true')
    formData.set('retryDelayMax', '1800')
    formData.set('expireInSeconds', '900')
    formData.set('retentionSeconds', '1209600')
    formData.set('deleteAfterSeconds', '604800')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    const queue = await getQueue(ctx.connectionString, ctx.schema, 'full-config-queue')
    expect(queue!.name).toBe('full-config-queue')
    expect(queue!.policy).toBe('stately')
    expect(queue!.partition).toBe(true)
    expect(queue!.deadLetter).toBe('dlq')
    expect(queue!.warningQueueSize).toBe(500)
    expect(queue!.retryLimit).toBe(3)
    expect(queue!.retryDelay).toBe(60)
    expect(queue!.retryBackoff).toBe(true)
    expect(queue!.retryDelayMax).toBe(1800)
    expect(queue!.expireInSeconds).toBe(900)
    expect(queue!.retentionSeconds).toBe(1209600)
    expect(queue!.deleteAfterSeconds).toBe(604800)
  })

  it('returns error for missing queue name', async () => {
    const formData = new FormData()

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    const result = await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    expect(result).toHaveProperty('error', 'Queue name is required')
  })

  it('returns error for invalid warning queue size', async () => {
    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('warningQueueSize', '-1')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    const result = await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    expect(result).toHaveProperty('error', 'Warning queue size must be a positive integer')
  })

  it('returns error for invalid retry limit', async () => {
    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('retryLimit', 'not-a-number')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    const result = await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    expect(result).toHaveProperty('error', 'Retry limit must be a non-negative integer')
  })

  it('returns error for invalid expiration seconds', async () => {
    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('expireInSeconds', '0')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    const result = await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    expect(result).toHaveProperty('error', 'Expire in seconds must be a positive integer')
  })

  it('returns error for invalid delete after seconds', async () => {
    const formData = new FormData()
    formData.set('queueName', 'test-queue')
    formData.set('deleteAfterSeconds', '-1')

    const request = new Request('http://localhost/queues/create', {
      method: 'POST',
      body: formData,
    })

    const result = await createQueueAction({
      request,
      context: { DB_URL: ctx.connectionString, SCHEMA: ctx.schema },
      params: {},
    })

    expect(result).toHaveProperty('error', 'Delete after seconds must be a non-negative integer (0 = never delete)')
  })
})
