# Pub-sub

Pub-sub in pg-boss is a light abstraction over creating more than 1 job into multiple queues from a single event. Otherwise, use `send()` or `insert()`.

### `publish(event, data, options)`

Publish an event with optional data and options (Same as `send()` args). Looks up all subscriptions for the event and sends to each queue.

A subscribed queue deleted while `publish()` is running is skipped, unless the send ran on a `db` you passed: a
failed statement may have aborted your transaction, so it is reported. Other send failures reject with an
`AggregateError` naming each failed queue after all sends settle. Outside a caller-owned transaction, successful
deliveries remain, so retrying the publication can duplicate them.

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

Each subscription carries the following properties.

| Property | Description |
| --- | --- |
| `event` | Event the queue is subscribed to |
| `name` | Queue that receives a job when the event is published |
| `createdOn` | When the subscription was first stored |
| `updatedOn` | When the subscription was last written |
