# Testing

pg-boss has built-in spies for writing fast, deterministic tests without polling or arbitrary delays.

## Enabling spies

Spies stay off until you set the `__test__enableSpies` constructor option, so they add no overhead in production.

```js
const boss = new PgBoss({
  connectionString: 'postgres://...',
  __test__enableSpies: true
})
```
> [!WARNING]
> Calling `getSpy()` without enabling spies will throw an error.

## `getSpy(name)`

Returns a spy for the given queue. The spy tracks every job state transition (created, active, completed, failed) on that queue.

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

Waits for a job that matches the selector function to reach the given state. If a matching job already reached that state before the call, the promise resolves immediately.

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

Waits for the job with this id to reach the given state. As with `waitForJob()`, if the job already reached that state before the call, the promise resolves immediately.

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

Clears all tracked job data from the spy. Use it to reset state between tests.

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

Anything that waits in pg-boss waits on a clock: a worker's next poll, a job's `startAfter`, a retry delay, a handler's expiration, a cron schedule's next minute. `TestClock` lets the test control that clock, in JavaScript and in Postgres. Pass one as the `clock` constructor option, and time moves only when the test moves it.

```js
import { PgBoss, TestClock } from 'pg-boss'

const clock = new TestClock('2026-01-01T00:00:00Z')
const boss = new PgBoss({ connectionString, clock, __test__enableSpies: true })
await boss.start()

await boss.work('q', async () => {})
const id = await boss.send('q', {}, { startAfter: 60 })

await clock.tick(60_000)   // JS dates, Postgres timestamps, and the worker's poll all move together
await boss.getSpy('q').waitForJobWithId(id, 'completed')
```

### `new TestClock(start?)`

Creates a clock that doesn't move on its own. `start` is a `Date`, epoch milliseconds, or a date string, and defaults to the real time at construction.

### `clock.now()`

Returns the current fake time in epoch milliseconds.

### `clock.tick(ms)`

Advances the clock by `ms` and fires every timer that falls due along the way, in due order. Before each timer fires, `tick` sets the clock to that timer's due time and pushes it to the database, so a poll that fires at second 30 runs its SQL against second 30. Intervals reschedule themselves after each firing. When the last due timer has fired, the clock lands on `now + ms`.

`tick` waits for pg-boss to settle, which means no pg-boss statement is in flight. It waits before it starts, after each timer it fires, and after it reaches the target. A worker poll that `tick` fires has finished its fetch by the time `tick` resolves. If that fetch came back empty and re-armed the poll before the target, the same `tick` fires it again.

`tick` doesn't wait for your handlers, including statements a transactional handler runs through its `tx`. Observe their outcomes with a spy or by querying, as above. Queries your code runs through `boss.getDb()` are the exception. They use pg-boss's own connection, so `tick` counts them, and a handler waiting on one holds up `tick` until it returns. Don't tick while your test holds a transaction open, because a pg-boss statement waiting on its lock keeps `tick` waiting too.

Only one `tick` or `setTime` can be in progress at a time, and another call to either rejects while one is running. An interval fires once per period crossed, so ticking an hour past a worker polling every two seconds runs 1800 polls. To jump, use `setTime`.

### `clock.setTime(t)`

Jumps to `t`, forwards or backwards, without firing anything. A forward jump counts as elapsed time, as it does in Postgres. Every timer the jump passed fires once on the next `tick`, and an interval then keeps its period from `t`. After a jump a month ahead, a worker polling every second polls once, and pg-boss fails a handler that's past its expiration. A backward jump leaves timers where they are, so they fire when the clock gets back to their due time. `setTime` rejects while a `tick` is in progress. Postgres evaluates `start_after <= now()` against an earlier time without complaint, so a test that moves backwards has to handle the consequences.

`setTime` settles first, like `tick`, then jumps. It takes whole milliseconds, but Postgres timestamps carry microseconds and pg-boss jitters retry backoff. So a job's `start_after` can fall a fraction of a millisecond after the millisecond you read. Round up before jumping to it, or the job won't be due yet.

### Database clock

While a `TestClock` is attached, `${schema}.job_now()`, the function every pg-boss statement reads the clock through, returns the fake time. That covers job creation and `start_after`, singleton slots, retry delays, expiration, maintenance and cron gating. It doesn't change `pg_catalog.now()` or your own SQL, and it leaves the `created_on` of rows your application inserts directly unaffected.

Only sessions that set `pgboss.test_clock = 'on'` see the fake time. An instance without a `TestClock` on the same schema keeps real time, and so does anything started after a killed run left the override behind.

`start()` declares that `SET` through the adapter's `setSessionStatements()`, before it opens a connection or runs a statement.

pg-boss refuses a `TestClock` on an adapter that doesn't implement `setSessionStatements()`. A pooled adapter that skipped the setup would silently read fake time on some connections and real time on others, differently on every checkout.

pg-boss's own pool applies the statements in its `connect` handler. The bundled PGlite adapter runs them once, which is all a single-session driver needs.

Releasing the clock restores the plain function body, drops the clock table, and issues `disableClockOverride()`.

With `PGliteWorker`, a single leader instance serves every tab, so all of them share the session setting. A `TestClock` attached through one tab puts every tab on fake time. pg-boss reapplies the setting when leadership moves to a new tab, because the move would otherwise silently drop the schema back to real time. It can't scope the setting to one instance, though.

`start()` attaches the clock after the schema is installed, and `stop()` releases it, which restores the real clock for that schema. Several instances can share one `TestClock`, and the schema stays on fake time until the last of them stops.

Anything pg-boss waits on that is not a clock, such as a database round trip or a handler's own promise, still takes real time.

The graceful `stop()` deadline stays on real time. It bounds shutdown I/O rather than queue time, so a test that stops while a handler is still running returns after `timeout` without ticking.

## Example test

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

## Race condition safety

The spy handles race conditions. You can call `waitForJob()` or `waitForJobWithId()` before or after the job reaches the state you want:

```js
const spy = boss.getSpy('my-queue')

// This works even if job completes before waitForJob is called
const waitPromise = spy.waitForJob((data) => data.id === '123', 'completed')

await boss.send('my-queue', { id: '123' })
await boss.work('my-queue', async () => {})

const job = await waitPromise // Resolves correctly
```

## Tracked states

| State | When tracked |
| - | - |
| `created` | Job inserted via `send()` or `insert()` |
| `active` | Job fetched by a worker and handler started |
| `completed` | Handler finished successfully |
| `failed` | Handler threw an error or job expired |
