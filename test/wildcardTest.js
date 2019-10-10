const Promise = require('bluebird');
const assert = require('chai').assert;
const helper = require('./testHelper');

describe('wildcard', function(){

  this.timeout(10000);

  let boss;

  before(async () => { boss = await helper.start() })
  after(() => boss.stop())

  it('fetch() should return all jobs using a wildcard pattern', function(finished) {
    const baseName = 'wildcard-fetch';

    Promise.join(
        boss.publish(`${baseName}_1234`),
        boss.publish(`${baseName}_5678`)
      )
      .then(() => boss.fetch(`${baseName}_*`, 2))
      .then(jobs => {
        assert.strictEqual(jobs.length, 2);
        finished()
      });

  });

  it('subscribe() should return all jobs using a wildcard pattern', function(finished) {
    const baseName = 'wildcard-subscribe';

    Promise.join(
        boss.publish(`${baseName}_1234`),
        boss.publish(`${baseName}_5678`)
      )
      .then(() => boss.subscribe(`${baseName}_*`, {batchSize: 2}, jobs => {
          assert.strictEqual(jobs.length, 2);
          finished();
        })
      );

  });

  it('should not accidentally fetch state completion jobs from a pattern', function(finished){

    const baseName = 'wildcard-fetch-incomplete';

    boss.publish(`${baseName}_1234`)
      .then(() => boss.fetch(`${baseName}_*`))
      .then(job => boss.complete(job.id))
      .then(() => boss.fetch(`${baseName}_*`))
      .then(job => {
        assert.strictEqual(job, null);
        finished()
      });

  });

});
