# Testing

bun-boss includes built-in spy support to help write fast, deterministic tests without polling or arbitrary delays.

## Enabling Spies

Spies must be explicitly enabled via the `__test__enableSpies` constructor option. This ensures zero overhead in production.

```js
const boss = new BunBoss({
  url: 'postgres://...',
  __test__enableSpies: true
})
```
As everywhere else in bun-boss, the queue must already exist — call `await boss.createQueue(name)` before sending or working, since queues are never created implicitly.

> [!WARNING]
> Calling `getSpy()` without enabling spies will throw an error.

## `getSpy<T>(name)`

Returns a spy instance for the specified queue. The spy tracks all job state transitions (created, active, completed, failed) for that queue. Transitions are recorded from the moment spies are enabled, not from the first `getSpy()` call — fetching the spy after a job has already settled still resolves waits for the states it passed through.

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

Supply the type argument to have `job.data` typed instead of `object`:

```ts
const spy = boss.getSpy<{ userId: string }>('my-queue')
```

### `spy.waitForJob(selector, state)`

Waits for a job matching the selector function to reach the specified state. If a job matching the selector criteria was already processed before this method was called, the promise will resolve immediately.

**Arguments**
- `selector`: function(data) => boolean, filters jobs by their data payload
- `state`: string, one of 'created', 'active', 'completed', 'failed'

```js
const boss = new BunBoss({
  url: process.env.DATABASE_URL,
  __test__enableSpies: true
})
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

Any `waitForJob()`/`waitForJobWithId()` promise still pending when `clear()` is called is dropped and will never settle — only call it between tests, never while a wait is outstanding.

```js
const spy = boss.getSpy('my-queue')

afterEach(() => {
  spy.clear()
})
```

## `clearSpies()`

Clears all spies and their tracked data across all queues. It also **removes** the spy objects, so a handle obtained before the call is permanently detached and never sees another transition — call `getSpy()` again after clearing rather than reusing a handle held in `beforeAll`.

```js
afterEach(() => {
  boss.clearSpies()
})
```

## Example Test

```js
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { BunBoss } from 'bun-boss'

describe('email notifications', () => {
  let boss
  let workerId

  beforeAll(async () => {
    boss = new BunBoss({
      url: process.env.DATABASE_URL,
      __test__enableSpies: true
    })
    await boss.start()
    await boss.createQueue('email-welcome')
  })

  afterAll(async () => {
    await boss.stop()
  })

  // Stop the test's worker, otherwise it keeps polling and can steal the next test's job
  afterEach(async () => {
    if (workerId) await boss.offWork('email-welcome', { id: workerId, wait: true })
    workerId = undefined
    boss.clearSpies()
  })

  test('should send welcome email when user signs up', async () => {
    const spy = boss.getSpy('email-welcome')

    // Start the worker
    workerId = await boss.work('email-welcome', async ([job]) => {
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

    expect(job.output).toEqual({ sent: true })
  })

  test('should handle email failures', async () => {
    const spy = boss.getSpy('email-welcome')

    workerId = await boss.work('email-welcome', async () => {
      throw new Error('SMTP connection failed')
    })

    const jobId = await boss.send('email-welcome', { email: 'test@example.com' })

    const job = await spy.waitForJobWithId(jobId, 'failed')

    expect(job.output.message).toBe('SMTP connection failed')
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
| `completed` | A worker's handler returned successfully, or `complete()` was called from inside a handler |
| `failed` | Handler threw an error and the job's retries were exhausted |

A handler that calls `fail()` and then returns normally is recorded as `failed`, not `completed`.

Spies observe the worker path only. A job settled outside a handler — `fetch()` followed by `complete()` — reaches `completed` in the database, but the spy never records it and a wait on that state will hang.

`retry` and `cancelled` are **not** tracked. `waitForJob()` with an untracked state never resolves and never rejects — TypeScript rejects it via `JobSpyState`, but plain JS will hang.
