# Pub-sub

Pub-sub in pg-boss is a light abstraction over creating more than 1 job into multiple queues from a single event. Otherwise, use `send()` or `insert()`.

### `publish(event, data, options)`

Publish an event with optional data and options (Same as `send()` args). Looks up all subscriptions for the event and sends to each queue.

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
