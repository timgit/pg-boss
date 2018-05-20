const states = {
  created: 'created',
  retry: 'retry',
  active: 'active',
  complete: 'completed',
  expired: 'expired',
  cancelled: 'cancelled',
  failed: 'failed'
};

const stateJobDelimiter = '__state__';
const completedJobSuffix = stateJobDelimiter + states.complete;

module.exports = {
  create,
  insertVersion,
  getVersion,
  versionTableExists,
  fetchNextJob,
  completeJobs,
  cancelJobs,
  failJobs,
  insertJob,
  expire,
  archive,
  purge,
  countStates,
  deleteQueue,
  deleteAllQueues,
  states,
  stateJobDelimiter,
  completedJobSuffix,
};

function create(schema) {
  return [
    createSchema(schema),
    tryCreateCryptoExtension(),
    createVersionTable(schema),
    createJobStateEnum(schema),
    createJobTable(schema),
    cloneJobTableForArchive(schema),
    addArchivedOnToArchive(schema),
    createIndexJobName(schema),
    createIndexJobFetch(schema),
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


function tryCreateCryptoExtension() {
  return `
    CREATE EXTENSION IF NOT EXISTS pgcrypto
  `;
}

function createVersionTable(schema) {
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.version (
      version text primary key
    )
  `;
}

function createJobStateEnum(schema) {
  // ENUM definition order is important
  // base type is numeric and first values are less than last values
  return `
    CREATE TYPE ${schema}.job_state AS ENUM (
      '${states.created}',
      '${states.retry}',
      '${states.active}',	
      '${states.complete}',
      '${states.expired}',
      '${states.cancelled}',
      '${states.failed}'
    )
  `;
}

function createJobTable(schema) {
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.job (
      id uuid primary key not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data json,
      state ${schema}.job_state not null default('${states.created}'),
      retryLimit integer not null default(0),
      retryCount integer not null default(0),
      retryDelay integer not null default(0),
      retryBackoff boolean not null default false,
      startAfter timestamp with time zone not null default now(),
      startedOn timestamp with time zone,
      singletonKey text,
      singletonOn timestamp without time zone,
      expireIn interval not null default interval '15 minutes',
      createdOn timestamp with time zone not null default now(),
      completedOn timestamp with time zone
    )
  `;
}

function cloneJobTableForArchive(schema){
  return `CREATE TABLE IF NOT EXISTS ${schema}.archive (LIKE ${schema}.job)`;
}

function addArchivedOnToArchive(schema) {
  return `ALTER TABLE ${schema}.archive ADD archivedOn timestamptz NOT NULL DEFAULT now()`;
}

function deleteQueue(schema){
  return `DELETE FROM ${schema}.job WHERE name = $1`;
}

function deleteAllQueues(schema){
  return `TRUNCATE ${schema}.job`;
}

function createIndexSingletonKey(schema){
  // anything with singletonKey means "only 1 job can be queued or active at a time"
  return `
    CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < '${states.complete}' AND singletonOn IS NULL
  `;
}

function createIndexSingletonOn(schema){
  // anything with singletonOn means "only 1 job within this time period, queued, active or completed"
  return `
    CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < '${states.expired}' AND singletonKey IS NULL
  `;
}

function createIndexSingletonKeyOn(schema){
  // anything with both singletonOn and singletonKey means "only 1 job within this time period with this key, queued, active or completed"
  return `
    CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < '${states.expired}'
  `;
}

function createIndexJobName(schema){
  return `
    CREATE INDEX job_name ON ${schema}.job (name) WHERE state < '${states.active}'
  `;
}

function createIndexJobFetch(schema){
  return `
    CREATE INDEX job_fetch ON ${schema}.job (name, priority desc, createdOn, id) WHERE state < '${states.active}'
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
  return `
    INSERT INTO ${schema}.version(version) VALUES ($1)
  `;
}

function fetchNextJob(schema) {
  return `
    WITH nextJob as (
      SELECT id
      FROM ${schema}.job
      WHERE state < '${states.active}'
        AND name = ANY($1)
        AND startAfter < now()
      ORDER BY priority desc, createdOn, id
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${schema}.job j SET
      state = '${states.active}',
      startedOn = now(),
      retryCount = CASE WHEN state = '${states.retry}' THEN retryCount + 1 ELSE retryCount END
    FROM nextJob
    WHERE j.id = nextJob.id
    RETURNING j.id, name, data
  `;
}

function completeJobs(schema){
  return `
    WITH results AS (
      UPDATE ${schema}.job
      SET completedOn = now(),
        state = '${states.complete}'
      WHERE id = ANY($1)
        AND state = '${states.active}'
      RETURNING *
    )
    INSERT INTO ${schema}.job (name, data)
    SELECT
      name || '${completedJobSuffix}', 
      json_build_object('request', json_build_object('id', id, 'name', name, 'data', data), 'response', $2::json, 'state', state)
    FROM results
    WHERE name NOT LIKE '%${completedJobSuffix}'
    RETURNING 1
  `; // returning 1 here just to count results against input array
}

function failJobs(schema){
  return `
    WITH results AS (
      UPDATE ${schema}.job
      SET state = CASE
          WHEN retryCount < retryLimit
          THEN '${states.retry}'::${schema}.job_state
          ELSE '${states.failed}'::${schema}.job_state
          END,        
        completedOn = CASE
          WHEN retryCount < retryLimit
          THEN NULL
          ELSE now()
          END,
        startAfter = CASE
          WHEN retryCount = retryLimit THEN startAfter
          WHEN NOT retryBackoff THEN now() + retryDelay * interval '1'
          ELSE now() +
            (
                retryDelay * 2 ^ LEAST(16, retryCount + 1) / 2
                +
                retryDelay * 2 ^ LEAST(16, retryCount + 1) / 2 * random()
            )
              * interval '1'
            END
      WHERE id = ANY($1)
        AND state < '${states.complete}'
      RETURNING *
    )
    INSERT INTO ${schema}.job (name, data)
    SELECT
      name || '${completedJobSuffix}',
      json_build_object('request', json_build_object('id', id, 'name', name, 'data', data), 'response', $2::json, 'state', state)
    FROM results
    WHERE state = '${states.failed}'
    RETURNING 1
  `; // returning 1 here just to count results against input array
}

function expire(schema) {
  return `
    WITH results AS (
      UPDATE ${schema}.job
      SET state = CASE
          WHEN retryCount < retryLimit THEN '${states.retry}'::${schema}.job_state
          ELSE '${states.expired}'::${schema}.job_state
          END,        
        completedOn = CASE
          WHEN retryCount < retryLimit
          THEN NULL
          ELSE now()
          END,
        startAfter = CASE
          WHEN retryCount = retryLimit THEN startAfter
          WHEN NOT retryBackoff THEN now() + retryDelay * interval '1'
          ELSE now() +
            (
                retryDelay * 2 ^ LEAST(16, retryCount + 1) / 2
                +
                retryDelay * 2 ^ LEAST(16, retryCount + 1) / 2 * random()
            )
            * interval '1'
          END
      WHERE state = '${states.active}'
        AND (startedOn + expireIn) < now()    
      RETURNING *
    )
    INSERT INTO ${schema}.job (name, data)
    SELECT
      name || '${completedJobSuffix}',
      json_build_object('request', json_build_object('id', id, 'name', name, 'data', data), 'response', null, 'state', state)
    FROM results
    WHERE state = '${states.expired}'
  `;
}

function cancelJobs(schema){
  return `
    UPDATE ${schema}.job
    SET completedOn = now(),
      state = '${states.cancelled}'
    WHERE id = ANY($1)
      AND state < '${states.complete}'
    RETURNING 1
  `;  // returning 1 here just to count results against input array
}

function insertJob(schema) {
  return `
    INSERT INTO ${schema}.job (
      id, 
      name, 
      priority, 
      state, 
      retryLimit, 
      startAfter, 
      expireIn, 
      data, 
      singletonKey, 
      singletonOn,
      retryDelay, 
      retryBackoff
      )
    VALUES (
      $1,
      $2,
      $3,
      '${states.created}',
      $4, 
      CASE WHEN right($5, 1) = 'Z' THEN CAST($5 as timestamp with time zone) ELSE now() + CAST(COALESCE($5,'0') as interval) END,
      CAST($6 as interval),
      $7,
      $8,
      CASE WHEN $9::integer IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ($9 * floor((date_part('epoch', now()) + $10) / $9)) ELSE NULL END,
      $11,
      $12
    )
    ON CONFLICT DO NOTHING
  `;
}

function purge(schema) {
  return `
    DELETE FROM ${schema}.archive
    WHERE (archivedOn + CAST($1 as interval) < now())
  `;
}

function archive(schema){
  return `
    WITH archived_rows AS (
      DELETE FROM ${schema}.job
      WHERE
        (completedOn + CAST($1 as interval) < now())
        OR (
          state = '${states.created}'
          AND name LIKE '%${stateJobDelimiter}%'
          AND createdOn + CAST($1 as interval) < now()
        )
      RETURNING *
    )
    INSERT INTO ${schema}.archive
    SELECT * FROM archived_rows
  `;
}

function countStates(schema){
  return `
    SELECT name, state, count(*) size
    FROM ${schema}.job
    WHERE name NOT LIKE '%${stateJobDelimiter}%'
    GROUP BY rollup(name), rollup(state)
  `;
}
