# Singleton Strict FIFO Queue Design

## Problem

pg-boss needs to handle FIFO queues where jobs with the same `singletonKey` are processed strictly in sequence. Current behavior allows the next job to be picked up while a previous job is retrying. The desired behavior:

1. Only one job active per `singletonKey` at a time
2. While a job is retrying, block the queue for that `singletonKey`
3. If retries exhaust and the job fails permanently, block until manual intervention
4. Unblock by either deleting the failed job (skip) or retrying it (retry)

## Design

### New Queue Policy

Add `'singleton_strict_fifo'` to `QUEUE_POLICIES`:

```typescript
const QUEUE_POLICIES = Object.freeze({
  standard: 'standard',
  short: 'short',
  singleton: 'singleton',
  stately: 'stately',
  exclusive: 'exclusive',
  singleton_strict_fifo: 'singleton_strict_fifo'
})
```

### Database Index

A partial unique index enforces the blocking behavior atomically:

```sql
CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key)
WHERE state IN ('active', 'retry', 'failed')
  AND policy = 'singleton_strict_fifo'
```

This ensures:
- Only one job per `singletonKey` can be in `active`, `retry`, or `failed` state
- When a worker tries to move a job from `created` → `active`, the index rejects it if another job with the same `singletonKey` is already blocking
- The same job can transition between these states (e.g., `retry` → `active`) since it's an update, not an insert

### State Transitions

```
created → active → completed (success, unblocks next job)
               ↓
             retry (blocks queue, waiting for retry delay)
               ↓
             active (retry attempt)
               ↓
             failed (blocks queue until manual intervention)
```

### API

#### 1. `createQueue(name, { policy: 'singleton_strict_fifo' })`

Creates a queue with the singleton_strict_fifo policy using the standard `createQueue()` method:

```typescript
await boss.createQueue('order-processing', {
  policy: 'singleton_strict_fifo',
  expireInSeconds: 60 * 5,
  retentionSeconds: 60 * 60 * 24 * 7
})
```

#### 2. `send()` Validation

When sending to a singleton_strict_fifo queue, `singletonKey` is required. Throws an error if missing:

```typescript
// Valid
await boss.send('order-processing', { orderId: '456' }, {
  singletonKey: 'order-456',
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true
})

// Throws: "singleton_strict_fifo queues require a singletonKey"
await boss.send('order-processing', { orderId: '456' }, {})
```

#### 3. `insert()` Validation

Batch inserts also require `singletonKey` for each job:

```typescript
// Valid
await boss.insert('order-processing', [
  { data: { order: 1 }, singletonKey: 'order-123' },
  { data: { order: 2 }, singletonKey: 'order-456' }
])

// Throws: "singleton_strict_fifo queues require a singletonKey"
await boss.insert('order-processing', [
  { data: { order: 1 } }
])
```

#### 4. `getBlockedKeys(queue)`

Returns an array of `singletonKey` values that are blocked by permanently failed jobs:

```typescript
const blockedKeys = await boss.getBlockedKeys('order-processing')
// ['order-123', 'order-789']
```

Implementation:
```sql
SELECT DISTINCT singleton_key as "singletonKey"
FROM pgboss.job
WHERE name = $1
  AND state = 'failed'
  AND policy = 'singleton_strict_fifo'
```

Note: This method throws an error if called on a non-singleton_strict_fifo queue.

#### 5. Unblocking Operations

Existing methods work for unblocking:

- `deleteJob(queue, id)` - Removes the failed job, allows next job to proceed
- `retry(queue, id)` - Puts failed job back to `retry` state with incremented retry_limit, it gets picked up next

#### 6. `work()` / `fetch()`

No changes needed. The unique index handles blocking at the database level. Workers that try to fetch a blocked job will simply get 0 rows affected and move on.

### Parallel Processing of Different singletonKeys

Jobs with different `singletonKey` values can be processed in parallel. The blocking only applies within the same `singletonKey`:

```typescript
// These two jobs can be processed concurrently
await boss.send('orders', { id: 1 }, { singletonKey: 'customer-A' })
await boss.send('orders', { id: 2 }, { singletonKey: 'customer-B' })
```

## Implementation

### Files Modified

1. **src/plans.ts**
   - Added `singleton_strict_fifo` to `QUEUE_POLICIES`
   - Added `createIndexJobPolicySingletonStrictFifo()` function
   - Added index creation to `createTableJobCommon()` and `createQueueFunction()`
   - Added `getBlockedKeys()` SQL function

2. **src/manager.ts**
   - Added `singletonKey` validation in `createJob()` for singleton_strict_fifo queues
   - Added `singletonKey` validation in `insert()` for singleton_strict_fifo queues
   - Added `getBlockedKeys()` method

3. **src/index.ts**
   - Exposed `getBlockedKeys()` on PgBoss class

4. **src/types.ts**
   - Added `'singleton_strict_fifo'` to `QueuePolicy` type

5. **src/migrationStore.ts**
   - Added migration version 28 with the FIFO index

6. **package.json**
   - Updated schema version to 28

### Tests

Tests are in `test/fifoTest.ts` covering:
- singletonKey requirement for send() and insert()
- Blocking during active state
- Blocking during retry state
- Blocking on permanent failure
- Parallel processing of different singletonKeys
- getBlockedKeys() API
- Unblocking via deleteJob() and retry()

### Example

See `examples/singleton/test-fifo-queue-policy.ts` for a comprehensive example demonstrating all behaviors.
