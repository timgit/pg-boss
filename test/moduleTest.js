const assert = require('assert')

describe('module', function () {
  it('should export states object', function () {
    const { states } = require('../')

    assert(states.created)
    assert(states.retry)
    assert(states.active)
    assert(states.completed)
    assert(states.expired)
    assert(states.cancelled)
    assert(states.failed)
  })
})
