"use strict";

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
  cancelJob: cancelJob,
  insertJob: insertJob,
  archive: archive
};

function createAll(schema) {
  return [createSchema(schema), createJobTable(schema), createVersionTable(schema)];
}

function createSchema(schema) {
  return "CREATE SCHEMA IF NOT EXISTS " + schema;
}

function createJobTable(schema) {
  return "\n        CREATE TABLE IF NOT EXISTS " + schema + ".job (\n            id uuid primary key not null,\n            name text not null,\n            data jsonb,\n            state text not null,\n            retryLimit integer not null default(0),\n            retryCount integer not null default(0),\n            startIn interval,\n            startedOn timestamp without time zone,\n            singletonOn timestamp without time zone,\n            expireIn interval,\n            expiredOn timestamp without time zone,\n            createdOn timestamp without time zone not null default now(),\n            completedOn timestamp without time zone,\n            CONSTRAINT job_singleton UNIQUE(name, singletonOn)\n        )";
}

function getVersion(schema) {
  return "select version from " + schema + ".version";
}

function createVersionTable(schema) {
  return "\n        CREATE TABLE IF NOT EXISTS " + schema + ".version (\n            version text primary key\n        )";
}

function versionTableExists(schema) {
  return "select to_regclass('" + schema + ".version') as name";
}

function insertVersion(schema) {
  return "INSERT INTO " + schema + ".version(version) VALUES ($1)";
}

function fetchNextJob(schema) {
  return "\n        WITH nextJob as (\n          SELECT id\n          FROM " + schema + ".job\n          WHERE (state = 'created' OR (state = 'expired' AND retryCount < 1))\n            AND name = $1\n            AND (createdOn + startIn) < now()\n          ORDER BY createdOn\n          LIMIT 1\n          FOR UPDATE SKIP LOCKED\n        )\n        UPDATE " + schema + ".job SET\n          state = 'active',\n          startedOn = now(),\n          retryCount = CASE WHEN state = 'expired' THEN retryCount + 1 ELSE retryCount END\n        FROM nextJob\n        WHERE " + schema + ".job.id = nextJob.id\n        RETURNING " + schema + ".job.id, " + schema + ".job.data";
}

function expireJob(schema) {
  return "\n        UPDATE " + schema + ".job\n        SET state = 'expired',\n            expiredOn = now()\n        WHERE state = 'active'\n        AND (startedOn + expireIn) < now()";
}

function completeJob(schema) {
  return "\n        UPDATE " + schema + ".job\n        SET completedOn = now(),\n            state = 'complete'\n        WHERE id = $1\n            AND state = 'active'";
}

function cancelJob(schema) {
  return "\n        UPDATE " + schema + ".job\n        SET completedOn = now(),\n            state = 'cancelled'\n        WHERE id = $1\n            AND state IN ('created','active')";
}

function insertJob(schema) {
  return "INSERT INTO " + schema + ".job (id, name, state, retryLimit, startIn, expireIn, data, singletonOn)\n            VALUES (\n                $1, $2, 'created', $3, CAST($4 as interval), CAST($5 as interval), $6,\n                CASE WHEN $7::integer IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ($7 * floor((date_part('epoch', now())) / $7)) ELSE NULL END\n            )\n            ON CONFLICT ON CONSTRAINT job_singleton DO NOTHING";
}

function archive(schema) {
  return "DELETE FROM " + schema + ".job WHERE completedOn + CAST($1 as interval) < now()";
}