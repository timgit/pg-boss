# Queue functions

You can create and delete queues with SQL functions.

### `pgboss.create_queue(queue_name text, options jsonb)`

`options` takes the same options as [`createQueue()`](../api/queues#createqueue-name-queue).

### `pgboss.delete_queue(queue_name text)`

Deletes a queue and all its jobs.
