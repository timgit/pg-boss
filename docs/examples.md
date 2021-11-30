- [Wildcard completion](#wildcard-completion)
- [Batch job fetch](#batch-job-fetch)

## Wildcard completion

Process based on matched pattern when jobs are completed to handle common completion logic.

```js
async function wildcardCompletion() {

  await boss.onComplete(`worker-register-*`, commonRegistrationCompletion)

  async function commonRegistrationCompletion(job) {
    if(job.data.failed)
      return console.log(`job ${job.data.request.id} failed`);
    
    await logRegistration(job.data.response);
  }

}
```

## Batch job fetch

Fetch an array of jobs in a worker. Returning a promise ensures no more jobs are fetched until it resolves.

```js
async function highVolumeWorker() {

  await boss.process('send-text-message', {batchSize: 1000}, handleSend);

  async function handleSend(jobs) {
    await Promise.all(jobs.map(job => textMessageService.send(job.data)));
  }

}
```