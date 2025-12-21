import { expect } from 'vitest'
import { states } from '../src/index.ts'

describe('module', function () {
  it('should export states object', function () {
    expect(states.created).toBeTruthy()
    expect(states.retry).toBeTruthy()
    expect(states.active).toBeTruthy()
    expect(states.completed).toBeTruthy()
    expect(states.cancelled).toBeTruthy()
    expect(states.failed).toBeTruthy()
  })
})
