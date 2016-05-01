module.exports = {
    createAll: createAll,
    createSchema: createSchema,
    createJobTable: createJobTable,
    createVersionTable: createVersionTable,
    insertVersion: insertVersion,
    getVersion: getVersion,
    versionTableExists: versionTableExists,
    fetchNextJob: fetchNextJob,
    expireJob: expireJob,
    completeJob: completeJob,
    insertJob: insertJob,
    archive: archive,
    getMigration: getMigration
};

function createAll(schema) {
    return [
        createSchema(schema),
        createJobTable(schema),
        createVersionTable(schema)
    ];
}

function createSchema(schema) {
    return `CREATE SCHEMA IF NOT EXISTS ${schema}`;
}

function createJobTable(schema) {
    return `
        CREATE TABLE IF NOT EXISTS ${schema}.job (
            id uuid primary key not null,
            name text not null,
            data jsonb,
            state text not null,
            retryLimit integer not null default(0),
            retryCount integer not null default(0),
            startIn interval,
            startedOn timestamp without time zone,
            singletonOn timestamp without time zone,
            expireIn interval,
            expiredOn timestamp without time zone,
            createdOn timestamp without time zone not null default now(),
            completedOn timestamp without time zone,
            CONSTRAINT job_singleton UNIQUE(name, singletonOn)
        )`;
}

function getVersion(schema) {
    return `select version from ${schema}.version`;
}

function createVersionTable(schema) {
    return `
        CREATE TABLE IF NOT EXISTS ${schema}.version (
            version text primary key
        )`;
}

function versionTableExists(schema) {
    return `select to_regclass('${schema}.version') as name`;
}

function insertVersion(schema) {
    return `INSERT INTO ${schema}.version(version) VALUES ($1)`;
}

function fetchNextJob(schema) {
    return `
        WITH nextJob as (
          SELECT id
          FROM ${schema}.job
          WHERE (state = 'created' OR (state = 'expired' AND retryCount < retryLimit))
            AND name = $1
            AND (createdOn + startIn) < now()
            AND completedOn IS NULL
          ORDER BY createdOn, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${schema}.job SET
          state = 'active',
          startedOn = now(),
          retryCount = CASE WHEN state = 'expired' THEN retryCount + 1 ELSE retryCount END
        FROM nextJob
        WHERE ${schema}.job.id = nextJob.id
        RETURNING ${schema}.job.id, ${schema}.job.data`;
}

function expireJob(schema) {
    return `
        UPDATE ${schema}.job
        SET state = 'expired',
            expiredOn = now()
        WHERE state = 'active'
        AND (startedOn + expireIn) < now()`;
}

function completeJob(schema){
    return `
        UPDATE ${schema}.job
        SET completedOn = now(),
            state = 'complete'
        WHERE id = $1`;
}

function insertJob(schema) {
    return `INSERT INTO ${schema}.job (id, name, state, retryLimit, startIn, expireIn, data, singletonOn)
            VALUES (
                $1, $2, $3, $4, CAST($5 as interval), CAST($6 as interval), $7, 
                CASE WHEN $8::integer IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ($8 * floor((date_part('epoch', now()) + $9) / $8)) ELSE NULL END
            )
            ON CONFLICT ON CONSTRAINT job_singleton DO NOTHING`;
}

function archive(schema) {
    return `
        DELETE FROM ${schema}.job
        WHERE state = 'completed'
        AND completedOn + CAST($1 as interval) < now()`;
}

function getMigration(schema, version, uninstall) {
    let migrations = [
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