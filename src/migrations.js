module.exports = {
    get: get
};

function get(schema, version, uninstall) {
    let migrations = getMigrations(schema);

    for(var m=0; m<migrations.length; m++){
        let migration = migrations[m];

        let targetVersion = uninstall ? 'previous' : 'version';
        let sourceVersion = uninstall ? 'version' : 'previous';

        let targetCommands = uninstall ? 'uninstall' : 'install';

        if(migration[sourceVersion] === version){
            let commands = migration[targetCommands].concat();
            commands.push(`UPDATE ${schema}.version SET version = '${migration[targetVersion]}'`);

            return {
                version: migration[targetVersion],
                commands
            };
        }
    }
}

function getMigrations(schema) {
    return [
        {
            version: '0.1.0',
            previous: '0.0.1',
            install: [
                `ALTER TABLE ${schema}.job ADD singletonOn timestamp without time zone`,
                `ALTER TABLE ${schema}.job ADD CONSTRAINT job_singleton UNIQUE(name, singletonOn)`,
                // one time truncate because previous schema was inserting each version
                `TRUNCATE TABLE ${schema}.version`,
                `INSERT INTO ${schema}.version(version) values('0.0.1')`
            ],
            uninstall: [
                `ALTER TABLE ${schema}.job DROP CONSTRAINT job_singleton`,
                `ALTER TABLE ${schema}.job DROP COLUMN singletonOn`
            ]
        },
        {
            version: '2',
            previous: '0.1.0',
            install: [
                `CREATE TYPE ${schema}.job_state AS ENUM (
                    'created',
                    'retry',
                    'active',
                    'complete',
                    'expired',
                    'cancelled'
                )`,
                `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
                `ALTER TABLE ${schema}.job DROP CONSTRAINT job_singleton`,
                `ALTER TABLE ${schema}.job ADD singletonKey text`,
                `CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < 'complete'`,
                `CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < 'complete' AND singletonKey IS NULL`,
                `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'complete' AND singletonOn IS NULL`,
                // migrate data to use retry state
                `UPDATE ${schema}.job SET state = 'retry' WHERE state = 'expired' AND retryCount < retryLimit`,
                // expired jobs weren't being archived in prev schema -- no rollback for this :)
                `UPDATE ${schema}.job SET completedOn = now() WHERE state = 'expired' and retryLimit = retryCount`,
                // just using good ole fashioned completedOn
                `ALTER TABLE ${schema}.job DROP COLUMN expiredOn`
            ],
            uninstall: [
                `DROP INDEX ${schema}.job_singletonOn`,
                `DROP INDEX ${schema}.job_singletonKeyOn`,
                `DROP INDEX ${schema}.job_singletonKey`,
                `ALTER TABLE ${schema}.job DROP COLUMN singletonKey`,
                `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE text`,
                `DROP TYPE ${schema}.job_state`,
                // restoring prev unique constraint
                `ALTER TABLE ${schema}.job ADD CONSTRAINT job_singleton UNIQUE(name, singletonOn)`,
                `ALTER TABLE ${schema}.job ADD expiredOn timestamp without time zone`,
                // roll retry state back to expired
                `UPDATE ${schema}.job SET state = 'expired' where state = 'retry'`
            ]
        }
    ];
}