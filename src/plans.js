module.exports = {
    create,
    insertVersion,
    getVersion,
    versionTableExists,
    fetchNextJob,
    expireJob,
    completeJob,
    cancelJob,
    insertJob,
    archive
};

function create(schema) {
    return [
        createSchema(schema),
        createVersionTable(schema),
        createJobStateEnum(schema),
        createJobTable(schema),
        createIndexSingletonOn(schema),
        createIndexSingletonKeyOn(schema),
        createIndexSingletonKey(schema)
    ];
}

function createSchema(schema) {
    return `
        CREATE SCHEMA IF NOT EXISTS ${schema}
    `;
}

function createVersionTable(schema) {
    return `
        CREATE TABLE IF NOT EXISTS ${schema}.version (
            version text primary key
        )`;
}

function createJobStateEnum(schema) {
    return `
        CREATE TYPE ${schema}.job_state AS ENUM (
            'created',
            'retry',
            'active',	
            'complete',
            'expired',
            'cancelled'
        )`;
}

function createJobTable(schema) {
    return `
        CREATE TABLE IF NOT EXISTS ${schema}.job (
            id uuid primary key not null,
            name text not null,
            data jsonb,
            state ${schema}.job_state not null,
            retryLimit integer not null default(0),
            retryCount integer not null default(0),
            startIn interval,
            startedOn timestamp without time zone,
            singletonKey text,
            singletonOn timestamp without time zone,
            expireIn interval,
            createdOn timestamp without time zone not null default now(),
            completedOn timestamp without time zone
        )`;
}


function createIndexSingletonOn(schema){
    return `
        CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < 'expired'
    `;
}

function createIndexSingletonKeyOn(schema){
    return `
        CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < 'expired'
    `;
}

function createIndexSingletonKey(schema){
    return `
        CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'complete'
    `;
}

function getVersion(schema) {
    return `
        SELECT version from ${schema}.version
    `;
}

function versionTableExists(schema) {
    return `
        SELECT to_regclass('${schema}.version') as name
    `;
}

function insertVersion(schema) {
    return `INSERT INTO ${schema}.version(version) VALUES ($1)`;
}

function fetchNextJob(schema) {
    return `
        WITH nextJob as (
          SELECT id
          FROM ${schema}.job
          WHERE state < 'active'
            AND name = $1
            AND (createdOn + startIn) < now()
          ORDER BY createdOn, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${schema}.job SET
          state = 'active',
          startedOn = now(),
          retryCount = CASE WHEN state = 'retry' THEN retryCount + 1 ELSE retryCount END
        FROM nextJob
        WHERE ${schema}.job.id = nextJob.id
        RETURNING ${schema}.job.id, ${schema}.job.data
    `;
}

function expireJob(schema) {
    return `
        UPDATE ${schema}.job
        SET state = CASE WHEN retryCount < retryLimit THEN 'retry'::${schema}.job_state ELSE 'expired'::${schema}.job_state END,        
            completedOn = CASE WHEN retryCount < retryLimit THEN NULL ELSE now() END
        WHERE state = 'active'
            AND (startedOn + expireIn) < now()
    `;
}

function completeJob(schema){
    return `
        UPDATE ${schema}.job
        SET completedOn = now(),
            state = 'complete'
        WHERE id = $1
            AND state = 'active'
    `;
}

function cancelJob(schema){
    return `
        UPDATE ${schema}.job
        SET completedOn = now(),
            state = 'cancelled'
        WHERE id = $1
            AND state < 'complete'
    `;
}

function insertJob(schema) {
    return `
        INSERT INTO ${schema}.job (id, name, state, retryLimit, startIn, expireIn, data, singletonKey, singletonOn)
        VALUES (
            $1, $2, 'created', $3, CAST($4 as interval), CAST($5 as interval), $6, $7,
            CASE WHEN $8::integer IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ($8 * floor((date_part('epoch', now())) / $8)) ELSE NULL END
        )
        ON CONFLICT DO NOTHING
    `;
}

function archive(schema) {
    return `
        DELETE FROM ${schema}.job WHERE completedOn + CAST($1 as interval) < now()
    `;
}
