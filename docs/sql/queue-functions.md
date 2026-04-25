# Queue functions

Queues can be created or deleted from SQL functions.

### `pgboss.create_queue(queue_name text, options jsonb)`

Options are the same as in [`createQueue()`](../api/queues#createqueuename-queue).

### `pgboss.delete_queue(queue_name text)`

Deletes a queue and all its jobs.
