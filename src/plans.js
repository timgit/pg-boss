const states = {
  created: 'created',
  retry: 'retry',
  active: 'active',
  complete: 'complete',
  expired: 'expired',
  cancelled: 'cancelled',
  failed: 'failed'
};

const stateJobSuffix = '__state__';
const expiredJobSuffix = stateJobSuffix + states.expired;
const completedJobSuffix = stateJobSuffix + states.complete;
const failedJobSuffix = stateJobSuffix + states.failed;
const retryFailedJobSuffix = stateJobSuffix + states.retry;

module.exports = {
  create,
  insertVersion,
  getVersion,
  versionTableExists,
  fetchNextJob,
  completeJob,
  completeJobs,
  cancelJob,
  cancelJobs,
  failJob,
  failJobs,
  retryJob,
  retryJobs,
  insertJob,
  expire,
  archive,
  countStates,
  states,
  expiredJobSuffix,
  completedJobSuffix,
  failedJobSuffix,
  retryFailedJobSuffix
};

function create(schema) {
  return [
    createSchema(schema),
    createVersionTable(schema),
    createJobStateEnum(schema),
    createJobTable(schema),
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
      id uuid primary key not null,
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state ${schema}.job_state not null default('${states.created}'),
      retryLimit integer not null default(0),
      retryCount integer not null default(0),
      retryIn interval,
      startIn interval not null default(interval '0'),
      startedOn timestamp with time zone,
      singletonKey text,
      singletonOn timestamp without time zone,
      expireIn interval,
      createdOn timestamp with time zone not null default now(),
      completedOn timestamp with time zone
    )
  `;
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

function createIndexJobFetch(schema){
  return `
    CREATE INDEX job_fetch ON ${schema}.job (priority desc, createdOn, id) WHERE state < '${states.active}'
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
        AND name = $1
        AND (createdOn + startIn) < now()
        AND ((retryIn IS NULL) OR (startedOn + retryIn) < now())
      ORDER BY priority desc, createdOn, id
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${schema}.job SET
      state = '${states.active}',
      startedOn = now(),
      retryCount = CASE WHEN state = '${states.retry}' THEN retryCount + 1 ELSE retryCount END
    FROM nextJob
    WHERE ${schema}.job.id = nextJob.id
    RETURNING ${schema}.job.id, $1 as name, ${schema}.job.data, ${schema}.job.retryCount,
      ${schema}.job.retryLimit, ${schema}.job.retryIn
  `;
}

function completeJob(schema){
  return `
    UPDATE ${schema}.job
    SET completedOn = now(),
      state = '${states.complete}'
    WHERE id = $1
      AND state = '${states.active}'
    RETURNING id, name, data
  `;
}

function completeJobs(schema){
  return `
    UPDATE ${schema}.job
    SET completedOn = now(),
      state = '${states.complete}'
    WHERE id = ANY($1)
      AND state = '${states.active}'
  `;
}

function cancelJob(schema){
  return `
    UPDATE ${schema}.job
    SET completedOn = now(),
      state = '${states.cancelled}'
    WHERE id = $1
      AND state < '${states.complete}'
    RETURNING id, name, data
  `;
}

function cancelJobs(schema){
  return `
    UPDATE ${schema}.job
    SET completedOn = now(),
      state = '${states.cancelled}'
    WHERE id = ANY($1)
      AND state < '${states.complete}'
  `;
}

function failJob(schema){
  return `
    UPDATE ${schema}.job
    SET completedOn = now(),
      state = '${states.failed}'
    WHERE id = $1
      AND state < '${states.complete}'
    RETURNING id, name, data
  `;
}

function failJobs(schema){
  return `
    UPDATE ${schema}.job
    SET completedOn = now(),
      state = '${states.failed}'
    WHERE id = ANY($1)
      AND state < '${states.complete}'
  `;
}

function retryJob(schema){
  return `
    UPDATE ${schema}.job
    SET retryIn = concat(LEAST($3, $2 * 2 ^ job.retryCount), ' seconds')::interval,
      state = '${states.retry}'
    WHERE id = $1
      AND state < '${states.complete}'
    RETURNING id, name, data
  `;
}

function retryJobs(schema){
  return `
    UPDATE ${schema}.job
    SET retryIn = concat(LEAST(100, 2 * 2 ^ job.retryCount), ' seconds')::interval,
      state = '${states.retry}'
    WHERE id = ANY($1)
      AND state < '${states.complete}'
  `;
}

function insertJob(schema) {
  return `
    INSERT INTO ${schema}.job (id, name, priority, state, retryLimit, startIn, expireIn, data, singletonKey, singletonOn)
    VALUES (
      $1, $2, $3, '${states.created}', $4, CAST($5 as interval), CAST($6 as interval), $7, $8,
      CASE WHEN $9::integer IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ($9 * floor((date_part('epoch', now()) + $10) / $9)) ELSE NULL END
    )
    ON CONFLICT DO NOTHING
  `;
}

function expire(schema) {
  return `
    WITH expired AS (
      UPDATE ${schema}.job
      SET state = CASE WHEN retryCount < retryLimit THEN '${states.retry}'::${schema}.job_state ELSE '${states.expired}'::${schema}.job_state END,
        completedOn = CASE WHEN retryCount < retryLimit THEN NULL ELSE now() END
      WHERE state = '${states.active}'
        AND (startedOn + expireIn) < now()
      RETURNING id, name, state, data
    )
    SELECT id, name, data FROM expired WHERE state = '${states.expired}';
  `;
}

function archive(schema) {
  return `
    DELETE FROM ${schema}.job
    WHERE (completedOn + CAST($1 as interval) < now())
      OR (
        state = '${states.created}'
        AND name LIKE '%${stateJobSuffix}%'
        AND createdOn + CAST($1 as interval) < now()
      )
  `;
}

function countStates(schema){
  return `
    SELECT
      COUNT(*) FILTER (where state = '${states.created}') as created,
      COUNT(*) FILTER (where state = '${states.retry}') as retry,
      COUNT(*) FILTER (where state = '${states.active}') as active,
      COUNT(*) FILTER (where state = '${states.complete}') as complete,
      COUNT(*) FILTER (where state = '${states.expired}') as expired,
      COUNT(*) FILTER (where state = '${states.cancelled}') as cancelled,
      COUNT(*) FILTER (where state = '${states.failed}') as failed
    FROM ${schema}.job
  `;
}
