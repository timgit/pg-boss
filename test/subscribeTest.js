var assert = require('chai').assert;
var helper = require('./testHelper');

describe('subscribe', function(){

    var boss;

    before(function(finished){
        helper.start()
            .then(dabauce => {
                boss = dabauce;
                finished();
            });
    });

    after(function(finished){
        boss.stop().then(() => finished());
    });

    it('should fail with no arguments', function(finished) {
        boss.subscribe().catch(error => {
            assert(true);
            finished();
        });
    });

    it('should fail if no callback provided', function(finished) {
        boss.subscribe('foo').catch(error => {
            assert(true);
            finished();
        });
    });

    it('should fail if options is not an object', function(finished) {
        boss.subscribe('foo', () => {}, 'nope').catch(error => {
            assert(true);
            finished();
        });
    });


});



