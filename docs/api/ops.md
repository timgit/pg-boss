# Operations

### `start()`

Returns the same PgBoss instance used during invocation

Prepares the target database and begins job monitoring.

```js
await boss.start()
await boss.send('hey-there', { msg:'this came for you' })
```

If the required database objects do not exist in the specified database, **`start()` will automatically create them**. The same process is true for updates as well. If a new schema version is required, pg-boss will automatically migrate the internal storage to the latest installed version.

> While this is most likely a welcome feature, be aware of this during upgrades since this could delay the promise resolution by however long the migration script takes to run against your data.  For example, if you happened to have millions of jobs in the job table just hanging around for archiving and the next version of the schema had a couple of new indexes, it may take a few seconds before `start()` resolves. Most migrations are very quick, however, and are designed with performance in mind.

Additionally, all schema operations, both first-time provisioning and migrations, are nested within advisory locks to prevent race conditions during `start()`. Internally, these locks are created using `pg_advisory_xact_lock()` which auto-unlock at the end of the transaction and don't require a persistent session or the need to issue an unlock. 

One example of how this is useful would be including `start()` inside the bootstrapping of a pod in a ReplicaSet in Kubernetes. Being able to scale up your job processing using a container orchestration tool like k8s is becoming more and more popular, and pg-boss can be dropped into this system without any special startup handling.

### `stop(options)`

Stops all background processing, such as maintenance and scheduling, as well as all polling workers started with `work()`.

By default, calling `stop()` without any arguments will gracefully wait for all workers to finish processing active jobs before resolving. Emits a `stopped` event if needed.

**Arguments**

* `options`: object

  * `graceful`, bool

    Default: `true`. If `true`, the PgBoss instance will wait for any workers that are currently processing jobs to finish, up to the specified timeout. During this period, new jobs will not be processed, but active jobs will be allowed to finish.

  * `close`, bool
    Default: `true`. If the database connection is managed by pg-boss, it will close the connection pool. Use `false` if needed to continue allowing operations such as `send()` and `fetch()`.

  * `timeout`, int

    Default: 30000. Maximum time (in milliseconds) to wait for workers to finish job processing before shutting down the PgBoss instance.

    Note: This option is ignored when `graceful` is set to `false`.


### `isInstalled()`

Utility function to see if pg-boss is installed in the configured database.

### `schemaVersion()`

Utility function to get the database schema version.

### `getBamStatus()`

Returns a summary of boss async migration (BAM) commands grouped by status.

BAM commands are database operations that run asynchronously after schema migrations, such as creating indexes on partitioned tables. This function provides a high-level overview of their progress.

```js
const status = await boss.getBamStatus()
// [
//   { status: 'completed', count: 5, lastCreatedOn: 2024-01-15T10:30:00.000Z },
//   { status: 'pending', count: 2, lastCreatedOn: 2024-01-15T10:31:00.000Z }
// ]
```

**Returns**

Array of objects with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `status` | string | One of: `pending`, `in_progress`, `completed`, `failed` |
| `count` | number | Number of BAM entries with this status |
| `lastCreatedOn` | Date | Most recent creation timestamp for this status |

### `getBamEntries()`

Returns all boss async migration (BAM) command entries with full details.

Use this function when you need to inspect individual BAM commands, troubleshoot failures, or review the command history.

```js
const entries = await boss.getBamEntries()
// [
//   {
//     id: '550e8400-e29b-41d4-a716-446655440000',
//     name: 'create-index',
//     version: 27,
//     status: 'completed',
//     queue: 'my-queue',
//     table: 'j1a2b3c4...',
//     command: 'CREATE INDEX ...',
//     error: null,
//     createdOn: 2024-01-15T10:30:00.000Z,
//     startedOn: 2024-01-15T10:30:01.000Z,
//     completedOn: 2024-01-15T10:30:05.000Z
//   }
// ]
```

**Returns**

Array of objects with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `id` | string | Unique identifier for the BAM entry |
| `name` | string | Name of the migration command |
| `version` | number | Schema version that created this command |
| `status` | string | One of: `pending`, `in_progress`, `completed`, `failed` |
| `queue` | string | Queue name (if applicable) |
| `table` | string | Target table name |
| `command` | string | SQL command to execute |
| `error` | string | Error message (if failed) |
| `createdOn` | Date | When the entry was created |
| `startedOn` | Date | When execution started |
| `completedOn` | Date | When execution completed |
