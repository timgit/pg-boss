# Operations

### `start()`

Returns the same BunBoss instance used during invocation

Prepares the target database and begins job monitoring.

```js
await boss.start()
await boss.createQueue('hey-there')
await boss.send('hey-there', { msg:'this came for you' })
```

If the required database objects do not exist in the specified database, **`start()` will automatically create them** at the current schema version (with `migrate: false`, `start()` verifies the existing schema instead and throws if it is missing or the wrong version). There is no in-place upgrade from an older installed schema version: if bun-boss finds a schema older than the version this release ships, `start()` throws rather than migrating it in place.

On Postgres and PGlite, schema installation is nested within an advisory lock to prevent race conditions during `start()`. Internally, this lock is created using `pg_advisory_xact_lock()` which auto-unlocks at the end of the transaction and doesn't require a persistent session or the need to issue an unlock. The SQLite backend has no advisory locks (do not run multiple bun-boss processes against one database file).

One example of how this is useful would be including `start()` inside the bootstrapping of a pod in a ReplicaSet in Kubernetes. Being able to scale up your job processing using a container orchestration tool like k8s is becoming more and more popular, and bun-boss can be dropped into this system without any special startup handling.

### `stop(options)`

Stops all background processing, such as maintenance and scheduling, as well as all polling workers started with `work()`.

By default, calling `stop()` without any arguments will gracefully wait for all workers to finish processing active jobs before resolving. Emits a `stopped` event if needed.

**Arguments**

* `options`: object

  * `graceful`, bool

    Default: `true`. If `true`, the BunBoss instance will wait for any workers that are currently processing jobs to finish, up to the specified timeout. During this period, new jobs will not be processed, but active jobs will be allowed to finish.

  * `close`, bool
    Default: `true`. If the database connection is managed by bun-boss, it will close the connection pool. Use `false` if needed to continue allowing operations such as `send()` and `fetch()`.

  * `timeout`, int

    Default: 30000. Maximum time (in milliseconds) to wait for workers to finish job processing before shutting down the BunBoss instance. Values below 1000 are raised to 1000.

    > [!WARNING]
    > This option is ignored when `graceful` is set to `false`.

```js
// graceful shutdown: wait for active jobs to finish (up to the timeout)
await boss.stop()

// stop workers but keep the connection pool open for send() and fetch()
await boss.stop({ close: false })

// shut down immediately without waiting for active jobs
await boss.stop({ graceful: false })
```

### `isInstalled()`

Utility function to see if bun-boss is installed in the configured database.

```js
const installed = await boss.isInstalled()
// true
```

### `schemaVersion()`

Utility function to get the database schema version.

```js
const version = await boss.schemaVersion()
// 1
```

### `supervise(name)`

Forces an immediate maintenance pass instead of waiting for the next background cycle: it monitors backlog, fails timed-out and heartbeat-stale jobs, deletes jobs past their retention window, and cleans up orphaned job dependencies. Pass a queue name to supervise a single queue, or omit it for all. Useful for deterministic tests, or when you have disabled `supervise` and drive maintenance yourself.

```js
await boss.supervise()
```

### `resolveFlow()`

Forces an immediate [flow](./jobs.md#flowjobs-options)-resolution pass, unblocking dependents of any parents that have completed, instead of waiting for the next background cycle. See [`resolveFlow()`](./jobs.md#resolveflow) for details.

### `isMaintaining()`

Returns `true` while the background maintenance pass is running. Use it to avoid launching a manual `supervise()` on top of the background one. A manual `supervise()` does not set this flag.

```js
const busy = boss.isMaintaining()
// false
```

### `isResolvingFlow()`

Returns `true` while a flow-resolution pass is running — including one started by a manual `resolveFlow()`.

### `isCheckingSkew()`

Returns `true` while the scheduler's clock-skew check is running.

### `getWipData(options)`

Returns the current worker work-in-progress snapshot — the same payload carried by the [`wip`](./events.md#wip) event. See [`getWipData()`](./workers.md#getwipdataoptions) on the Workers page.

### `getDb()`

Returns the `Db` instance (the `IDatabase` interface, exported as `Db`) bun-boss is using — the built-in Bun `SQL` driver, or the adapter you passed as the `db` option. Use it to run your own SQL over the same connection via `executeSql(text, values)` instead of opening a second pool.

```js
const db = boss.getDb()
const { rows } = await db.executeSql('select now()', [])
```

bun-boss owns the built-in driver's lifecycle; a `db` you supplied stays yours to open and close.
