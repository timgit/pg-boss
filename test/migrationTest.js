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

        this.timeout(3000);

        contractor.create()
            .then(() => db.migrate(currentSchemaVersion, 'remove'))
            .then(version => {
                assert.notEqual(version, currentSchemaVersion);
                return db.migrate(version);
            })
            .then(version => {
                assert.equal(version, currentSchemaVersion);
                finished();
            });
    });

    it('should migrate to latest during start if on previous schema version', function(finished){

        this.timeout(3000);

        contractor.create()
            .then(() => db.migrate(currentSchemaVersion, 'remove'))
            .then(() => new PgBoss(helper.config).start())
            .then(() => contractor.version())
            .then(version => {
                assert.equal(version, currentSchemaVersion);
                finished();
            });
    });

    it('should migrate through 2 versions back and forth', function (finished) {

        this.timeout(3000);

        let prevVersion;

        contractor.create()
            .then(() => db.migrate(currentSchemaVersion, 'remove'))
            .then(version => {
                prevVersion = version;
                assert.notEqual(version, currentSchemaVersion);

                return db.migrate(version, 'remove');
            })
            .then(version => {
                assert.notEqual(version, prevVersion);

                return db.migrate(version);
            })
            .then(version => {
                assert.equal(version, prevVersion);

                return db.migrate(version);
            })
            .then(version => {
                assert.equal(version, currentSchemaVersion);
                finished();
            });
    });


    it('should migrate to latest during start if on previous 2 schema versions', function(finished){

        this.timeout(3000);

        contractor.create()
            .then(() => db.migrate(currentSchemaVersion, 'remove'))
            .then(version => db.migrate(version, 'remove'))
            .then(() => new PgBoss(helper.config).start())
            .then(() => contractor.version())
            .then(version => {
                assert.equal(version, currentSchemaVersion);
                finished();
            });
    });

});
