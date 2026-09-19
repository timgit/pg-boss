import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderNotices, type ThirdPartyPackage } from './third-party.ts'

/**
 * Writes `build/THIRD-PARTY-NOTICES` from what the build actually bundled.
 *
 * The published package carries third-party code compiled into its own files,
 * where it is no longer accompanied by the licence text npm used to install
 * beside it. MIT, ISC and Apache-2.0 all ask for the notice to travel with the
 * redistribution, so it travels in here.
 *
 * Generated from `build/third-party.json`, not from `package.json`: bundling
 * means a devDependency can be redistributed and a dependency can be untouched,
 * and only the module graph knows which.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(
  readFileSync(join(root, 'build/third-party.json'), 'utf8')
) as { packages: ThirdPartyPackage[] }

const preamble = `pg-boss dashboard — third-party notices

This package contains code from the projects below, compiled into its own
build output. Each is redistributed under its own licence, reproduced here in
full. Nothing in this file changes the licence of the dashboard itself.`

writeFileSync(join(root, 'build/THIRD-PARTY-NOTICES'), renderNotices(data.packages, preamble))

console.log(`> THIRD-PARTY-NOTICES: ${data.packages.length} packages`)
