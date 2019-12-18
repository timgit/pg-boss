const Promise = require('bluebird');
const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');

describe('database', function(){

    this.timeout(10000);

    it('should fail on invalid database host', async function() {

        const boss = new PgBoss('postgres://bobby:tables@wat:12345/northwind');

        try {
            await boss.start()
            assert(false)
        } catch {
            await boss.stop()
        }

    })

    it('should work with a custom schema name', async function() {

        const jobName = 'custom-schema';

        let config = helper.getConfig();
        config.schema = '_queue';

        try {
            const boss = await helper.start(config)
            const jobId = await boss.publish(jobName)
            const job = await boss.fetch(jobName)

            assert(job.id === jobId)
        } catch(err) {
            assert(false, err.message)
        }

    });

    it('can be swapped out via BYODB', async function() {

        const query = 'SELECT something FROM somewhere'

        const mydb = {
            executeSql: async (text, values) => ({ rows:[], text, rowCount: 0 })
        }

        const boss = new PgBoss({ db: mydb })

        await boss.start()

        const response = await boss.db.executeSql(query)
        
        assert(response.text === query)
        
        await boss.stop()
        
    })

    it('connection count does not exceed configured pool size with `poolSize`', async function() {

        const listenerCount = 100;
        const poolSize = 5;
        const configOption = 'poolSize'

        await poolSizeConnectionTest(listenerCount, poolSize, configOption)

    });

    it('connection count does not exceed configured pool size with `max`', async function() {

        const listenerCount = 100;
        const poolSize = 5;
        const configOption = 'max'

        await poolSizeConnectionTest(listenerCount, poolSize, configOption)

    });

    async function poolSizeConnectionTest(listenerCount, poolSize, configOption) {
        
        let listeners = [];
        
        for(let x = 0; x<listenerCount; x++) {
            listeners[x] = x;
        }

        const boss = await helper.start({[configOption]: poolSize })      
        const prevConnectionCount = await countConnections(boss.db)

        await Promise.map(listeners, (val, index) => boss.subscribe(`job${index}`, () => {}))

        await Promise.delay(3000)

        const connectionCount = await countConnections(boss.db)

        let newConnections = connectionCount - prevConnectionCount;

        console.log(`listeners: ${listenerCount}  pool size: ${poolSize}`);
        console.log('connections:');
        console.log(`  before subscribing: ${prevConnectionCount}  now: ${connectionCount}  new: ${newConnections}`);

        assert(newConnections <= poolSize)

        await boss.stop()

        async function countConnections(db) {
            
            const sql = 'SELECT count(*) as connections FROM pg_stat_activity WHERE application_name=$1'
            const values = [ boss.db.config.application_name ]

            const result = await db.executeSql(sql, values)

            return parseFloat(result.rows[0].connections)
        }
    }

});
