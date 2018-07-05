const assert = require('chai').assert;

describe('module', function(){

  it('should export states object', function(){

    const { states } = require('../src/index');

    assert.isOk(states.created);
    assert.isOk(states.retry);
    assert.isOk(states.active);
    assert.isOk(states.completed);
    assert.isOk(states.expired);
    assert.isOk(states.cancelled);
    assert.isOk(states.failed);

  });

});
