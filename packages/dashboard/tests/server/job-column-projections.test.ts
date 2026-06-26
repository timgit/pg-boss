import { describe, expect, it } from 'vitest'
import {
  buildJobColumnProjections,
  jobColumnPathToSql,
} from '~/lib/queries.server'

describe('job column SQL projections', () => {
  it('builds SQL projections for full JSON columns and nested paths', () => {
    expect(jobColumnPathToSql('data')).toBe('data')
    expect(jobColumnPathToSql('output')).toBe('output')
    expect(jobColumnPathToSql('data.tenant.id'))
      .toBe("data #>> ARRAY['tenant','id']")
    expect(jobColumnPathToSql('data.tenantId'))
      .toBe("data #>> ARRAY['tenantId']")
    expect(jobColumnPathToSql("data.tenant's.id"))
      .toBe("data #>> ARRAY['tenant''s','id']")
    expect(buildJobColumnProjections([
      { path: 'id', name: 'ID' },
      { path: 'data.name', name: 'Job name' },
      { path: 'data.tenant.id', name: 'Nested tenant' },
      { path: 'data.tenantId', name: 'Tenant' },
      { path: 'data.bad-key', name: 'Quoted' },
      { path: 'groupId', name: 'Group' },
    ])).toEqual([
      'data #>> ARRAY[\'name\'] as "data.name"',
      'data #>> ARRAY[\'tenant\',\'id\'] as "data.tenant.id"',
      'data #>> ARRAY[\'tenantId\'] as "data.tenantId"',
      'data #>> ARRAY[\'bad-key\'] as "data.bad-key"',
      'group_id as "groupId"',
    ])
  })
})
