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
> [!WARNING]
> Calling `getSpy()` without enabling spies will throw an error.

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

## Controlling time

Anything that waits in pg-boss waits on a clock: a worker's next poll, a job's `startAfter`, a retry delay, a handler's expiration, a cron schedule's next minute. `TestClock` puts that clock in the test's hands, on both sides of the connection. Pass one as the `clock` constructor option and time moves only when the test says so.

```js
import { PgBoss, TestClock } from 'pg-boss'

const clock = new TestClock('2026-01-01T00:00:00Z')
const boss = new PgBoss({ connectionString, clock, __test__enableSpies: true })
await boss.start()

await boss.work('q', async () => {})
const id = await boss.send('q', {}, { startAfter: 60 })

await clock.tick(60_000)   // Date, Postgres now(), and the worker's poll all move together
await boss.getSpy('q').waitForJobWithId(id, 'completed')
```

### `new TestClock(start?)`

`start` is a `Date`, epoch milliseconds, or a date string; it defaults to the real time at construction. Once created, the clock does not move on its own.

### `clock.now()`

The current fake time in epoch milliseconds.

### `clock.tick(ms)`

Advances the clock by `ms`, firing every timer that falls due along the way in due order. Before each timer fires, the clock is set to that timer's due time and pushed to the database, so a poll that fires at second 30 runs its SQL against second 30. Intervals reschedule themselves after each firing. When the last due timer has fired, the clock lands on `now + ms`.

`tick` does not wait for the I/O a timer callback starts. A worker poll fired by `tick` has issued its fetch by the time `tick` resolves, but the handler may still be running. Observe outcomes with a spy or by querying, as above. Only one `tick` may be in progress at a time; a second call while one is running rejects.

### `clock.setTime(t)`

Jumps to `t`, forwards or backwards, without firing anything. Postgres will happily evaluate `start_after <= now()` against an earlier time; a test that moves backwards owns the consequences.

### The Postgres side

While a `TestClock` is attached, `${schema}.now()`, the function every pg-boss statement reads the clock through, returns the fake time. That covers job creation and `start_after`, singleton slots, retry delays, expiration, maintenance and cron gating. It does not change `pg_catalog.now()` or your own SQL, and the `created_on` of rows your application inserts directly are unaffected.

`start()` attaches the clock after the schema is installed, and `stop()` releases it, restoring the real clock for that schema. One `TestClock` may be shared by several instances; the schema stays on fake time until the last of them stops.

Anything pg-boss waits on that is not a clock, such as a database round trip or a handler's own promise, still takes real time.

The graceful `stop()` deadline is a clock timer as well. A test that stops while a handler is still running must either `tick` past the timeout or stop with `graceful: false`; otherwise `stop()` waits on a deadline that never arrives.

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
