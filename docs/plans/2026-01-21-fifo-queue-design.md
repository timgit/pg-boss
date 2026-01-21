# FIFO Queue Design

## Problem

pg-boss needs to handle FIFO queues where jobs with the same `singletonKey` are processed strictly in sequence. Current behavior allows the next job to be picked up while a previous job is retrying. The desired behavior:

1. Only one job active per `singletonKey` at a time
2. While a job is retrying, block the queue for that `singletonKey`
3. If retries exhaust and the job fails permanently, block until manual intervention
4. Unblock by either deleting the failed job (skip) or retrying it (retry)

## Design

### New Queue Policy

Add `'fifo'` to `QUEUE_POLICIES`:

```typescript
const QUEUE_POLICIES = Object.freeze({
  standard: 'standard',
  short: 'short',
  singleton: 'singleton',
  stately: 'stately',
  exclusive: 'exclusive',
  fifo: 'fifo'
})
```

### Database Index

A partial unique index enforces the blocking behavior atomically:

```sql
CREATE UNIQUE INDEX job_i_fifo ON pgboss.job (name, singleton_key)
WHERE state IN ('active', 'retry', 'failed')
  AND policy = 'fifo'
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

### API Changes

#### 1. `createFifoQueue(name, options?)`

Creates a queue with `policy: 'fifo'`. Options are the standard queue options minus retry settings (those are per-job).

```typescript
await boss.createFifoQueue('order-processing', {
  expireInSeconds: 60 * 5,
  retentionSeconds: 60 * 60 * 24 * 7
})
```

#### 2. `send()` Validation

When sending to a FIFO queue, `singletonKey` is required. Throws an error if missing:

```typescript
// Valid
await boss.send('order-processing', { orderId: '456' }, {
  singletonKey: 'order-456',
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true
})

// Throws: "FIFO queues require a singletonKey"
await boss.send('order-processing', { orderId: '456' }, {})
```

#### 3. `getBlockedKeys(queue)`

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
  AND policy = 'fifo'
```

#### 4. Unblocking Operations

Existing methods work for unblocking:

- `deleteJob(queue, id)` - Removes the failed job, allows next job to proceed
- `retryJob(queue, id)` - Puts failed job back to `retry` state with incremented retry_limit, it gets picked up next

#### 5. `work()` / `fetch()`

No changes needed. The unique index handles blocking at the database level. Workers that try to fetch a blocked job will simply get 0 rows affected and move on.

## Implementation Tasks

1. Add `'fifo'` to `QUEUE_POLICIES` in `src/plans.ts`
2. Create the FIFO index function `createIndexJobPolicyFifo()` in `src/plans.ts`
3. Add index creation to `createTableJobCommon()` and `createQueueFunction()`
4. Add migration for existing databases
5. Add `createFifoQueue()` method to manager
6. Add `singletonKey` validation in `send()` for FIFO queues
7. Add `getBlockedKeys()` method
8. Add tests for FIFO behavior
