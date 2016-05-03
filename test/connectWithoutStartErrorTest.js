var assert = require('chai').assert;
var PgBoss = require('../lib/index');
var config = require('./config.json');
var Db = require('../lib/db');


describe('initialization', function(){
    it('should fail if connecting to an uninitialized instance', function(finished) {

        // todo: temp test for travis config override
        if(process.env.TRAVIS) {
            config.port = 5433;
            config.password = '';
        }

        var db = new Db(config);

        db.executeSql('DROP SCHEMA IF EXISTS ' + config.schema + ' CASCADE')
            .then(test);

        function test() {
            var boss = new PgBoss(config);

            boss.on('error', function(error) {
                assert.isNotNull(error);
                finished();
            });

            boss.connect();
        }

    });

    it('should start with a connection string', function(finished) {

        // todo: temp test for travis config override
        if(process.env.TRAVIS) {
            config.port = 5433;
            config.password = '';
        }

        var connectionString = 'postgres://' + config.user + ':' + config.password + '@' + config.host + ':' + config.port + '/' + config.database;

        var db = new Db(config);

        db.executeSql('DROP SCHEMA IF EXISTS ' + config.schema + ' CASCADE')
            .then(test);

        function test() {
            var boss = new PgBoss(connectionString);

            boss.on('ready', function() {
                assert(true);
                finished();
            });

            boss.start();
        }

    });

});
