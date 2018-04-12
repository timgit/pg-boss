const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');
const Contractor = require('../src/contractor');
const currentSchemaVersion = require('../version.json').schema;

describe('migration', function() {

  this.timeout(10000);

  let contractor = new Contractor(helper.getDb(), helper.getConfig());

  beforeEach(function(finished){
    helper.init()
      .then(() => finished());
  });

  it('should migrate to previous version and back again', function (finished) {
    contractor.create()
      .then(() => contractor.migrate(currentSchemaVersion, 'remove'))
      .then(version => {
        assert.notEqual(version, currentSchemaVersion);
        return contractor.migrate(version);
      })
      .then(version => {
        assert.equal(version, currentSchemaVersion);
        finished();
      });
  });

  it('should migrate to latest during start if on previous schema version', function(finished){
    contractor.create()
      .then(() => contractor.migrate(currentSchemaVersion, 'remove'))
      .then(() => new PgBoss(helper.getConfig()).start())
      .then(() => contractor.version())
      .then(version => {
        assert.equal(version, currentSchemaVersion);
        finished();
      });
  });

  it('should migrate through 2 versions back and forth', function (finished) {
    let prevVersion;

    contractor.create()
      .then(() => contractor.migrate(currentSchemaVersion, 'remove'))
      .then(version => {
        prevVersion = version;
        assert.notEqual(version, currentSchemaVersion);

        return contractor.migrate(version, 'remove');
      })
      .then(version => {
        assert.notEqual(version, prevVersion);

        return contractor.migrate(version);
      })
      .then(version => {
        assert.equal(version, prevVersion);

        return contractor.migrate(version);
      })
      .then(version => {
        assert.equal(version, currentSchemaVersion);
        finished();
      });
  });


  it('should migrate to latest during start if on previous 2 schema versions', function(finished){
    contractor.create()
      .then(() => contractor.migrate(currentSchemaVersion, 'remove'))
      .then(version => contractor.migrate(version, 'remove'))
      .then(() => new PgBoss(helper.getConfig()).start())
      .then(() => contractor.version())
      .then(version => {
        assert.equal(version, currentSchemaVersion);
        finished();
      });
  });

  it('migrating to non-existent version fails gracefully', function(finished){
    contractor.create()
      .then(() => contractor.migrate('¯\_(ツ)_/¯'))
      .catch(error => {
        assert(error.message.indexOf('could not be found') > -1);
        finished();
      });
  });

});
