# Events

Each pg-boss instance is an EventEmitter, and contains the following events.

## `error`
The `error` event could be raised during internal processing, such as scheduling and maintenance. Adding a listener to the error event is strongly encouraged because of the default behavior of Node.

> If an EventEmitter does not have at least one listener registered for the 'error' event, and an 'error' event is emitted, the error is thrown, a stack trace is printed, and the Node.js process exits.
>
>Source: [Node.js Events > Error Events](https://nodejs.org/api/events.html#events_error_events)

Ideally, code similar to the following example would be used after creating your instance, but before `start()` is called.

```js
boss.on('error', error => logger.error(error));
```

## `monitor-states`

The `monitor-states` event is conditionally raised based on the `monitorStateInterval` configuration setting and only emitted from `start()`. If passed during instance creation, it will provide a count of jobs in each state per interval.  This could be useful for logging or even determining if the job system is handling its load.

The payload of the event is an object with a key per queue and state, such as the  following example.

```json
{
  "queues": {
      "send-welcome-email": {
        "created": 530,
        "retry": 40,
        "active": 26,
        "completed": 3400,
        "cancelled": 0,
        "failed": 49,
        "all": 4049
      },
      "archive-cleanup": {
        "created": 0,
        "retry": 0,
        "active": 0,
        "completed": 645,
        "cancelled": 0,
        "failed": 0,
        "all": 645
      }
  },
  "created": 530,
  "retry": 40,
  "active": 26,
  "completed": 4045,
  "cancelled": 0,
  "failed": 4,
  "all": 4694
}
```
## `wip`

Emitted at most once every 2 seconds when workers are receiving jobs. The payload is an array that represents each worker in this instance of pg-boss.  If you'd rather monitor activity across all instances, use `monitor-states`.

```js
[
  {
    id: 'fc738fb0-1de5-4947-b138-40d6a790749e',
    name: 'my-queue',
    options: { pollingInterval: 2000 },
    state: 'active',
    count: 1,
    createdOn: 1620149137015,
    lastFetchedOn: 1620149137015,
    lastJobStartedOn: 1620149137015,
    lastJobEndedOn: null,
    lastJobDuration: 343
    lastError: null,
    lastErrorOn: null
  }
]
```

## `stopped`

Emitted after `stop()` once all workers have completed their work and maintenance has been shut down.
