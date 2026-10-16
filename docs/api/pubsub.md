# Pub-sub

Pub-sub in pg-boss is a light layer for creating jobs in more than 1 queue from a single event. For a single queue, use `send()` or `insert()`.

### `publish(event, data, options)`

Publishes an event with optional data and options, which take the same arguments as `send()`. It looks up every subscription to the event and sends to each subscribed queue.

If a subscribed queue is deleted while `publish()` runs, `publish()` skips it. The exception is a send that ran
on a `db` you passed, which `publish()` reports, because the failed statement may have aborted your transaction.
Once every send settles, any other failures reject with an `AggregateError` that names each failed queue. Outside
a transaction you own, the sends that succeeded keep their jobs, so retrying `publish()` can duplicate them.

```js
// creates a job in each queue subscribed to 'user.signed-up'
await boss.publish('user.signed-up', { userId: 123 })
```

### `subscribe(event, name)`

Subscribe queue `name` to `event`.

```js
await boss.subscribe('user.signed-up', 'email-welcome')
await boss.subscribe('user.signed-up', 'crm-sync')

// this creates a job in both queues
await boss.publish('user.signed-up', { userId: 123 })
```

### `unsubscribe(event, name)`

Remove the subscription of queue `name` to `event`.

```js
await boss.unsubscribe('user.signed-up', 'crm-sync')
```
