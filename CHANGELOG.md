# Changelog

## [0.4.0](https://github.com/khromov/bun-boss/compare/bun-boss-v0.3.0...bun-boss-v0.4.0) (2026-08-17)


### ⚠ BREAKING CHANGES

* **config:** add tableIsolation with prefix mode ([#48](https://github.com/khromov/bun-boss/issues/48))

### Features

* **config:** add tableIsolation with prefix mode ([#48](https://github.com/khromov/bun-boss/issues/48)) ([230dd07](https://github.com/khromov/bun-boss/commit/230dd07c4cf77a377049f6443b2b4dfbce77ae98))

## [0.3.0](https://github.com/khromov/bun-boss/compare/bun-boss-v0.2.4...bun-boss-v0.3.0) (2026-08-10)


### Features

* **worker:** burst immediately after a non-empty fetch ([#45](https://github.com/khromov/bun-boss/issues/45)) ([3729da5](https://github.com/khromov/bun-boss/commit/3729da55a206c21a9f1fc45d74b9280ed81a4c5c))


### Bug Fixes

* **adapters:** key json classifier solely on explicit casts, retire ISSUES.txt ([#34](https://github.com/khromov/bun-boss/issues/34)) ([3dcbce1](https://github.com/khromov/bun-boss/commit/3dcbce1e7fb28ece41d8638e18ad153845ac826e))

## [0.2.4](https://github.com/khromov/bun-boss/compare/bun-boss-v0.2.3...bun-boss-v0.2.4) (2026-08-09)


### Bug Fixes

* **deps:** move @types/bun out of production dependencies ([#43](https://github.com/khromov/bun-boss/issues/43)) ([20935ab](https://github.com/khromov/bun-boss/commit/20935abfb11e24d3e563f84dacaa84e0836fcf11))

## [0.2.3](https://github.com/khromov/bun-boss/compare/bun-boss-v0.2.2...bun-boss-v0.2.3) (2026-08-08)


### Bug Fixes

* emit real Error on worker/queue-cache paths and forward ignoreStartAfter in work() ([#41](https://github.com/khromov/bun-boss/issues/41)) ([6c188f2](https://github.com/khromov/bun-boss/commit/6c188f2c791f6ec6a66e146cea89ac6223b2f26d))

## [0.2.2](https://github.com/khromov/bun-boss/compare/bun-boss-v0.2.1...bun-boss-v0.2.2) (2026-08-08)


### Bug Fixes

* **docs:** use absolute sidebar links so nested pages don't 404 ([bf27583](https://github.com/khromov/bun-boss/commit/bf2758380d1abd70979bd511f05ffab6cf837d70))

## [0.2.1](https://github.com/khromov/bun-boss/compare/bun-boss-v0.2.0...bun-boss-v0.2.1) (2026-08-07)


### Bug Fixes

* record spy transitions for queues before their first getSpy() call ([5c2a4f5](https://github.com/khromov/bun-boss/commit/5c2a4f5f229204761bf86a42a8a4eeddd494d5c9))

## [0.2.0](https://github.com/khromov/bun-boss/compare/bun-boss-v0.1.0...bun-boss-v0.2.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* drop the pg driver, back the built-in db with Bun SQL
* the package ships uncompiled TypeScript, so Node cannot import it from node_modules without a bundler. Bun 1.4+ only.
* `PgBoss` is now `BunBoss` and the package is published as `bun-boss`. No compatibility alias is exported.
* **api:** remove pub/sub, key_strict_fifo policy, and localGroupConcurrency
* removes detectSchemaDrift(), getMigrationPlans(), getRollbackPlans(), getBamStatus(), getBamEntries(), isBamWorking(), the `bam` event, the cockroachdb/yugabytedb/citus backend profiles, the persistQueueStats/persistWarnings/queueStatRetentionDays/warningRetentionDays and bamIntervalSeconds options, and getQueueStats() history options (from/to/limit/bucketSeconds/maxDataPoints/aggregate). No in-place upgrade from an existing pg-boss database.

### Features

* **api:** remove pub/sub, key_strict_fifo policy, and localGroupConcurrency ([4c17224](https://github.com/khromov/bun-boss/commit/4c172243e0f09c6f3cc9109924747c88ba7222e3))
* drop the pg driver, back the built-in db with Bun SQL ([21a3e57](https://github.com/khromov/bun-boss/commit/21a3e57e7624fc851714dbc152c4fa261ab5bb9c))
* publish raw TypeScript, drop the build step ([f6ccdf5](https://github.com/khromov/bun-boss/commit/f6ccdf50817556c811e81a83a8a897bc0c075e50))
* rename package to bun-boss ([23ad3b9](https://github.com/khromov/bun-boss/commit/23ad3b9c628ea855bf33bdcf90bd9c1877e5d9b9))
* slim to a Postgres/PGlite/SQLite core, drop ops machinery ([8db0707](https://github.com/khromov/bun-boss/commit/8db07079915dd4c8f66f756ef830a87864eaa7ae))


### Bug Fixes

* **contractor:** tolerate the duplicate-key flavor of the install race ([5d07d88](https://github.com/khromov/bun-boss/commit/5d07d888ce1cacf5e8aabd317b4bd54a5855bf97))
* **schedule:** keep an occurrence in the current second in scope ([aa7eaf4](https://github.com/khromov/bun-boss/commit/aa7eaf4b6c0ef6352910a069e295eb5abb751c3f))
