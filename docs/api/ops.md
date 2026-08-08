# Operations

### `start()`

Returns the same BunBoss instance used during invocation

Prepares the target database and begins job monitoring.

```js
await boss.start()
await boss.send('hey-there', { msg:'this came for you' })
```

If the required database objects do not exist in the specified database, **`start()` will automatically create them** at the current schema version. There is no in-place upgrade from an older installed schema version: if bun-boss finds a schema older than the version this release ships, `start()` throws rather than migrating it in place.

Schema installation is nested within an advisory lock to prevent race conditions during `start()`. Internally, this lock is created using `pg_advisory_xact_lock()` which auto-unlocks at the end of the transaction and doesn't require a persistent session or the need to issue an unlock.

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

    Default: 30000. Maximum time (in milliseconds) to wait for workers to finish job processing before shutting down the BunBoss instance.

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
