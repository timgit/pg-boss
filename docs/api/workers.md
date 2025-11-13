# Workers

### `work()`

Adds a new polling worker for a queue and executes the provided callback function when jobs are found. Each call to work() will add a new worker and resolve a unqiue worker id.

Workers can be stopped via `offWork()` all at once by queue name or individually by using the worker id. Worker activity may be monitored by listening to the `wip` event.

The default options for `work()` is 1 job every 2 seconds.

### `work(name, options, handler)`

**Arguments**
- `name`: string, *required*
- `options`: object
- `handler`: function(jobs), *required*

**Options**

* **batchSize**, int, *(default=1)*

  Same as in [`fetch()`](#fetch)

* **includeMetadata**, bool, *(default=false)*

  Same as in [`fetch()`](#fetch)

* **priority**, bool, *(default=true)*

  Same as in [`fetch()`](#fetch)

* **pollingIntervalSeconds**, int, *(default=2)*

  Interval to check for new jobs in seconds, must be >=0.5 (500ms)


**Handler function**

`handler` should return a promise (Usually this is an `async` function). If an unhandled error occurs in a handler, `fail()` will automatically be called for the jobs, storing the error in the `output` property, making the job or jobs available for retry.

The jobs argument is an array of jobs with the following properties.

| Prop | Type | |
| - | - | -|
|`id`| string, uuid |
|`name`| string |
|`data`| object |


An example of a worker that checks for a job every 10 seconds.

```js
await boss.work('email-welcome', { pollingIntervalSeconds: 10 }, ([ job ]) => myEmailService.sendWelcomeEmail(job.data))
```

An example of a worker that returns a maximum of 5 jobs in a batch.

```js
await boss.work('email-welcome', { batchSize: 5 }, (jobs) => myEmailService.sendWelcomeEmails(jobs.map(job => job.data)))
```

### `work(name, handler)`

Simplified work() without an options argument

```js
await boss.work('email-welcome', ([ job ]) => emailer.sendWelcomeEmail(job.data))
```

work() with active job deletion

```js
const queue = 'email-welcome'

await boss.work(queue, async ([ job ]) => {
  await emailer.sendWelcomeEmail(job.data)
  await boss.deleteJob(queue, job.id)
})
```

### `notifyWorker(id)`

Notifies a worker by id to bypass the job polling interval (see `pollingIntervalSeconds`) for this iteration in the loop.


### `offWork(name, options)`

Removes a worker by name or id and stops polling.

** Arguments **
- name: string
- options: object

**Options**

* **wait**, boolean, *(default=true)*

  If the promise should wait until current jobs finish

* **id**, string

  Only stop polling by worker id
