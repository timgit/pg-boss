# Pub-sub

Pub-sub in pg-boss is a light layer for creating jobs in more than 1 queue from a single event. For a single queue, use `send()` or `insert()`.

### `publish(event, data, options)`

Publishes an event with optional data and options, which take the same arguments as `send()`. It looks up every subscription to the event and sends to each subscribed queue.

If a subscribed queue is deleted while `publish()` runs, `publish()` skips the queue unless the send ran on a
`db` you passed. In that case `publish()` reports the failure, because the failed statement may have aborted your
transaction. Once every send settles, `publish()` rejects with an `AggregateError` that names each failed queue it
didn't skip. Outside a transaction you own, the sends that succeeded keep their jobs. Retrying `publish()` can
duplicate those jobs.

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

### `getSubscriptions(event?, options)`

Returns subscriptions, sorted by event and queue name. Pass an event to read only that event's subscriptions.

`options` takes `limit`, from 1 to 100,000 with a default of 1000, and `after`, the last row of the previous page.

```js
const subscriptions = await boss.getSubscriptions()

for (const { event, name } of subscriptions) {
  console.log(`${event} -> ${name}`)
}

const signedUp = await boss.getSubscriptions('user.signed-up')
```

A subscription has these properties:

| Property | Description |
| --- | --- |
| `event` | Event the queue is subscribed to |
| `name` | Queue that receives a job when the event is published |
| `createdOn` | When the subscription was first stored |
| `updatedOn` | When the subscription was last written |
