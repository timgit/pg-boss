# Pub-sub

Pub-sub in pg-boss is a light abstraction over creating more than 1 job into multiple queues from a single event. Otherwise, use `send()` or `insert()`.

### `publish(event, data, options)`

Publish an event with optional data and options (Same as `send()` args). Looks up all subscriptions for the event and sends to each queue.

### `subscribe(event, name)`

Subscribe queue `name` to `event`.

### `unsubscribe(event, name)`

Remove the subscription of queue `name` to `event`.
