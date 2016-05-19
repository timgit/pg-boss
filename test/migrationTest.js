var assert = require('chai').assert;
var PgBoss = require('../src/index');
var helper = require('./testHelper');
var Contractor = require('../src/contractor');
var currentSchemaVersion = require('../version.json').schema;

describe('migration', function() {

    var db = helper.getDb();
    var contractor = new Contractor(helper.config);

    beforeEach(function(finished){
        helper.init()
            .then(() => finished());
    });

    it('should migrate to previous version and back again', function (finished) {
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
            .then(() => {
                var boss = new PgBoss(helper.config);
                boss.on('ready', () => {
                    contractor.version()
                        .then(version => {
                            assert.equal(version, currentSchemaVersion);
                            finished();
                        })
                });

                boss.start();
            });

    });

});
