var assert = require('chai').assert;
var PgBoss = require('../lib/index');
var config = require('./config.json');

describe('examples', function(){
    it('readme example is totes valid', function(finished){

        // todo: temp test for travis config override
        if(process.env.TRAVIS) {
            config.port = 5433;
            config.password = '';
        }

        var connectionString = 'postgres://' + config.user + ':' + config.password + '@' + config.host + ':' + config.port + '/' + config.database;
        var boss = new PgBoss(connectionString);

        // example start
        boss.on('error', error);
        boss.on('ready', ready);

        boss.start();

        function ready() {
            boss.publish('work', {message: 'stuff'})
                .then(function(jobId){
                    console.log('created job ' + jobId);
                });

            boss.subscribe('work', null, function(data, done) {
                console.log('received work job with payload ' + data.message);

                done().then(function() {
                    console.log('Confirmed done');
                    assert(true); // exclude test code
                    finished();   // exclude test code
                });
            });
        }

        function error(err){
            console.error(err);
        }
        // example end
    });
});
