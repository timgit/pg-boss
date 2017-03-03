var assert = require('chai').assert;
var PgBoss = require('../src/index');
var helper = require('./testHelper');
var Contractor = require('../src/contractor');
var currentSchemaVersion = require('../version.json').schema;

describe('migration', function() {

    var db = helper.getDb();
    var contractor = new Contractor(helper.getConfig());

    beforeEach(function(finished){
        helper.init()
            .then(() => finished());
    });

    it('should migrate to previous version and back again', function (finished) {
        this.timeout(3000);

        contractor.create()
            .then(() => db.migrate(currentSchemaVersion, 'remove'))
            .then(() => contractor.version())
            .then(version => {
                assert(version);
                assert.notEqual(version, currentSchemaVersion);

                return db.migrate(version);
            })
            .then(() => contractor.version())
            .then(version => {
                assert.equal(version, currentSchemaVersion);
                finished();
            });
    });

    it('should migrate to latest during start if on previous schema version', function(finished){

        contractor.create()
            .then(() => db.migrate(currentSchemaVersion, 'remove'))
            .then(() => new PgBoss(helper.getConfig()).start())
            .then(() => contractor.version())
            .then(version => {
                assert.equal(version, currentSchemaVersion);
                finished();
            });
    });

    it('migrating to non-existent version fails gracefully', function(finished){

        contractor.create()
            .then(() => db.migrate('¯\_(ツ)_/¯'))
            .catch(error => {
                assert(error.message.indexOf('could not be found') > -1);
                finished();
            });
    });

});
