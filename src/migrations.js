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
        }
    ];
}