const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');
const Contractor = require('../src/contractor');
const currentSchemaVersion = require('../version.json').schema;

describe('migration', function() {

    let db = helper.getDb();
    let contractor = new Contractor(db, helper.getConfig());

    beforeEach(function(finished){
        helper.init()
            .then(() => finished());
    });

    it('should migrate to previous version and back again', function (finished) {
        this.timeout(5000);

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
            .then(() => new PgBoss(helper.getConfig()).start())
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

        this.timeout(5000);

        contractor.create()
            .then(() => db.migrate(currentSchemaVersion, 'remove'))
            .then(version => db.migrate(version, 'remove'))
            .then(() => new PgBoss(helper.getConfig()).start())
            .then(() => contractor.version())
            .then(version => {
                assert.equal(version, currentSchemaVersion);
                finished();
            });
    });

    it('migrating to non-existent version fails gracefully', function(finished){

        this.timeout(5000);

        contractor.create()
            .then(() => db.migrate('¯\_(ツ)_/¯'))
            .catch(error => {
                assert(error.message.indexOf('could not be found') > -1);
                finished();
            });
    });

});
