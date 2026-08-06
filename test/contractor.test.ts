import { describe, it, expect } from './harness.ts'
import { ctx } from './hooks.ts'
import Contractor from '../src/contractor.ts'
import { getConfig } from '../src/attorney.ts'
import type { IDatabase } from '../src/types.ts'

// The install race is timing-dependent (multiMaster.test.ts only hits it under a warm concurrent
// pool), so these pin the tolerated error shapes deterministically through a throwing fake db —
// including the driver fields (code, constraint) the duplicate-key flavor depends on.
function contractorThrowing (err: unknown): Contractor {
  const db: IDatabase = {
    async executeSql () {
      throw err
    }
  }
  return new Contractor(db, getConfig(ctx.bossConfig))
}

describe('contractor', function () {
  it('create() tolerates the already-exists message flavor of the install race', async function () {
    await contractorThrowing(new Error('relation "version" already exists')).create()
  })

  it('create() tolerates the duplicate-pg_namespace-key flavor of the install race', async function () {
    // The real message lacks 'already exists' — only code + constraint identify this flavor.
    const err = Object.assign(new Error('duplicate key value violates unique constraint "pg_namespace_nspname_index"'), {
      code: '23505',
      constraint: 'pg_namespace_nspname_index'
    })
    await contractorThrowing(err).create()
  })

  it('create() rethrows a duplicate key on any other constraint', async function () {
    const err = Object.assign(new Error('duplicate key value violates unique constraint "version_pkey"'), {
      code: '23505',
      constraint: 'version_pkey'
    })
    await expect(contractorThrowing(err).create()).rejects.toThrow('version_pkey')
  })

  it('create() rethrows unrelated errors', async function () {
    const err = Object.assign(new Error('permission denied for database'), { code: '42501' })
    await expect(contractorThrowing(err).create()).rejects.toThrow('permission denied')
  })
})
