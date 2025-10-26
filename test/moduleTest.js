import assert from 'node:assert'
import { states } from '../src/index.js'

describe('module', function () {
  it('should export states object', function () {
    assert(states.created)
    assert(states.retry)
    assert(states.active)
    assert(states.completed)
    assert(states.cancelled)
    assert(states.failed)
  })
})
