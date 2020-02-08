const assert = require('chai').assert
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('multi-master', function () {
  this.timeout(10000)

  it('should only allow 1 master to start at a time', async function () {
    const instances = 10

    try {
      await Promise.map(new Array(instances), () => helper.start())
    } catch (err) {
      assert(false)
    }
  })
})
