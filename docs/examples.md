<!-- TOC -->

- [Async Readme](#async-readme)

<!-- /TOC -->

## Async Readme

Same as readme, but with async await

```js

const PgBoss = require('pg-boss');

try {
  await readme();
} catch (err) {
  console.error(err);
}

async function readme() {

  const boss = new PgBoss('postgres://user:pass@host/database');
  boss.on('error', error => console.error(error));
  
  await boss.start();

  const queue = 'some-queue';

  let jobId = await boss.publish(queue, {param1: 'parameter1'});
  
  console.log(`created job in queue ${queue}: ${jobId}`);

  await boss.subscribe(queue, job => await onJob(job));

  await boss.onComplete(queue, job => {
    console.log(`job ${job.data.request.id} completed`);
    console.log(` - in state ${job.data.state}`);
    console.log(` - responded with '${job.data.response.value}'`);
  });

  async function onJob(job) {
    console.log(`job ${job.id} received`);
    console.log(` - with data: ${JSON.stringify(job.data)}`);
      
    return 'got it';
  }

}

```
