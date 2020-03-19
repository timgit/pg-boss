const assert = require('assert')
const { schemaVersion } = require('../lib/schemaVersion')

describe('schemaVersion', () => {
  it('should be a number', () => {
    assert(typeof schemaVersion === 'number', 'schemaVersion is a number')
  })
})
