# Testing

pg-boss includes built-in spy support to help write fast, deterministic tests without polling or arbitrary delays.

## Enabling Spies

Spies must be explicitly enabled via the `__test__enableSpies` constructor option. This ensures zero overhead in production.

```js
const boss = new PgBoss({
  connectionString: 'postgres://...',
  __test__enableSpies: true
})
```

> **Note:** Calling `getSpy()` without enabling spies will throw an error.

## `getSpy(name)`

Returns a spy instance for the specified queue. The spy tracks all job state transitions (created, active, completed, failed) for that queue.

**Arguments**
- `name`: string, queue name

**Returns**

A spy object with the following interface:

```ts
interface JobSpyInterface<T = object> {
  clear(): void
  waitForJob(selector: (data: T) => boolean, state: JobSpyState): Promise<SpyJob<T>>
  waitForJobWithId(id: string, state: JobSpyState): Promise<SpyJob<T>>
}

type JobSpyState = 'created' | 'active' | 'completed' | 'failed'

interface SpyJob<T = object> {
  id: string
  name: string
  data: T
  state: JobSpyState
  output?: object
}
```

### `spy.waitForJob(selector, state)`

Waits for a job matching the selector function to reach the specified state. If a job matching the selector criteria was already processed before this method was called, the promise will resolve immediately.

**Arguments**
- `selector`: function(data) => boolean, filters jobs by their data payload
- `state`: string, one of 'created', 'active', 'completed', 'failed'

```js
const boss = new PgBoss({ ..., __test__enableSpies: true })
await boss.start()

const spy = boss.getSpy('my-queue')

// Wait for any job with userId '123' to complete
const job = await spy.waitForJob(
  (data) => data.userId === '123',
  'completed'
)

console.log(job.output) // handler result
```

### `spy.waitForJobWithId(id, state)`

Waits for a specific job by id to reach the specified state. Like `waitForJob()`, if the job already reached the specified state before this method was called, the promise will resolve immediately.

**Arguments**
- `id`: string, job id
- `state`: string, one of 'created', 'active', 'completed', 'failed'

```js
const spy = boss.getSpy('my-queue')

const jobId = await boss.send('my-queue', { userId: '123' })

// Wait for this specific job to complete
const job = await spy.waitForJobWithId(jobId, 'completed')
```

### `spy.clear()`

Clears all tracked job data from the spy. Useful for resetting state between tests.

```js
afterEach(() => {
  spy.clear()
})
```

## `clearSpies()`

Clears all spies and their tracked data across all queues.

```js
afterEach(() => {
  boss.clearSpies()
})
```

## Example Test

```js
const PgBoss = require('pg-boss')
const assert = require('assert')

describe('email notifications', () => {
  let boss

  before(async () => {
    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      __test__enableSpies: true
    })
    await boss.start()
  })

  after(async () => {
    await boss.stop()
  })

  afterEach(() => {
    boss.clearSpies()
  })

  it('should send welcome email when user signs up', async () => {
    const spy = boss.getSpy('email-welcome')

    // Start the worker
    await boss.work('email-welcome', async ([job]) => {
      await sendEmail(job.data.email, 'Welcome!')
      return { sent: true }
    })

    // Trigger the action that creates the job
    await userService.signUp({ email: 'test@example.com' })

    // Wait for job to complete - no polling needed
    const job = await spy.waitForJob(
      (data) => data.email === 'test@example.com',
      'completed'
    )

    assert.deepStrictEqual(job.output, { sent: true })
  })

  it('should handle email failures', async () => {
    const spy = boss.getSpy('email-welcome')

    await boss.work('email-welcome', async () => {
      throw new Error('SMTP connection failed')
    })

    const jobId = await boss.send('email-welcome', { email: 'test@example.com' })

    const job = await spy.waitForJobWithId(jobId, 'failed')

    assert.strictEqual(job.output.message, 'SMTP connection failed')
  })
})
```

## Race Condition Safety

The spy is designed to handle race conditions gracefully. You can call `waitForJob()` or `waitForJobWithId()` before or after the job reaches the desired state:

```js
const spy = boss.getSpy('my-queue')

// This works even if job completes before waitForJob is called
const waitPromise = spy.waitForJob((data) => data.id === '123', 'completed')

await boss.send('my-queue', { id: '123' })
await boss.work('my-queue', async () => {})

const job = await waitPromise // Resolves correctly
```

## Tracked States

| State | When Tracked |
| - | - |
| `created` | Job inserted via `send()` or `insert()` |
| `active` | Job fetched by a worker and handler started |
| `completed` | Handler finished successfully |
| `failed` | Handler threw an error or job expired |
