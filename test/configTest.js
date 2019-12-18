const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');

describe('config', function(){

    this.timeout(10000);

    before(async () => helper.init())

    it('should allow a 50 character custom schema name', async function() {

        const config = helper.getConfig()
        config.schema = 'thisisareallylongschemanamefortestingmaximumlength';

        await helper.init(config.schema)

        const boss = new PgBoss(config)
        
        await boss.start()
        await boss.stop()

        await helper.init(config.schema)

    });

    it('should not allow a 51 character custom schema name', function() {
        const config = helper.getConfig()
        config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb'
        assert.throws(() => new PgBoss(config))
    });

    it('should accept a connectionString property', async function(){

        const connectionString = helper.getConnectionString()

        const boss = new PgBoss({ connectionString })

        await boss.start()
        await boss.stop()

    });

    it('should accept a connectionString and schema properties', function() {
        const connectionString = 'postgresql://postgres@127.0.0.1:5432/db';
        const schema = 'pgboss_custom_schema';
        const boss = new PgBoss({ connectionString, schema });

        assert.equal(boss.config.schema, schema);
    });

    it('set pool config `poolSize`', async function() {

        const poolSize = 14;

        const boss = await helper.start({ poolSize })
        
        assert(boss.db.config.poolSize === poolSize)
        assert(boss.db.pool.options.max === poolSize)

        await boss.stop()
    })

    it('set pool config `max`: `poolSize` === `max`', async function() {

        const max = 13;

        const boss = await helper.start({ max })

        assert(boss.db.config.max === boss.db.config.poolSize)
        assert(boss.db.config.max === max)
        assert(boss.db.config.poolSize === max)
        assert(boss.db.pool.options.max === max)

        await boss.stop()
    })

});
