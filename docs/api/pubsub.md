# Pub-sub

Pub-sub in pg-boss is a light layer for creating jobs in more than 1 queue from a single event. For a single queue, use `send()` or `insert()`.

### `publish(event, data, options)`

Publishes an event with optional data and options, which take the same arguments as `send()`. It looks up every subscription to the event and sends to each subscribed queue.

If a subscribed queue is deleted while `publish()` runs, `publish()` skips the queue unless the send ran on a
`db` you passed. In that case `publish()` reports the failure, because the failed statement may have aborted your
transaction. Once every send settles, `publish()` rejects with an `AggregateError` that names each failed queue it
didn't skip. Outside a transaction you own, the sends that succeeded keep their jobs, so retrying `publish()` can
duplicate them.

```js
// creates a job in each queue subscribed to 'user.signed-up'
await boss.publish('user.signed-up', { userId: 123 })
```

### `subscribe(event, name)`

Subscribes queue `name` to `event`.

```js
await boss.subscribe('user.signed-up', 'email-welcome')
await boss.subscribe('user.signed-up', 'crm-sync')

// this creates a job in both queues
await boss.publish('user.signed-up', { userId: 123 })
```

### `unsubscribe(event, name)`

Removes the subscription of queue `name` to `event`.

```js
await boss.unsubscribe('user.signed-up', 'crm-sync')
```
