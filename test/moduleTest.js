import assert from 'node:assert'
import PgBoss from '../src/index.js'

const states = PgBoss.states

describe('module', () => {
  it('should export states object', () => {
    assert(states.created)
    assert(states.retry)
    assert(states.active)
    assert(states.completed)
    assert(states.cancelled)
    assert(states.failed)
  })
})
