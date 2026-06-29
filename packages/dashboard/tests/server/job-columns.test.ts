import { describe, expect, it } from 'vitest'
import {
  buildJobColumnProjections,
  jobColumnPathToSql,
} from '~/lib/queries.server'
import {
  appendJobColumns,
  createJobColumn,
  DEFAULT_JOB_COLUMNS,
  DEFAULT_QUEUE_JOB_COLUMNS,
  getRowCellValue,
  parseJobColumns,
  type JobColumn,
} from '~/lib/job-columns'

describe('job columns', () => {
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

  it('parses and serializes column params', () => {
    const customColumns: JobColumn[] = [
      { path: 'id', name: 'ID' },
      { path: 'data.tenantId', name: 'Tenant' },
      { path: 'output.status', name: 'Status' },
    ]
    const params = new URLSearchParams()

    expect(parseJobColumns(params)).toEqual(DEFAULT_JOB_COLUMNS)
    expect(parseJobColumns(params, DEFAULT_QUEUE_JOB_COLUMNS)).toEqual(DEFAULT_QUEUE_JOB_COLUMNS)

    appendJobColumns(params, customColumns)
    expect(params.getAll('col')).toEqual([
      'id|ID',
      'data.tenantId|Tenant',
      'output.status|Status',
    ])
    expect(parseJobColumns(params)).toEqual(customColumns)

    appendJobColumns(params, DEFAULT_JOB_COLUMNS)
    expect(params.toString()).toBe('')
  })

  it('rejects unsupported paths and falls back to defaults', () => {
    expect(parseJobColumns(new URLSearchParams('col=data.tenant.id'))).toEqual([
      { path: 'data.tenant.id', name: 'data.tenant.id' },
    ])
    expect(createJobColumn('data.')).toBeNull()
    expect(parseJobColumns(new URLSearchParams('col=bad|Bad'))).toEqual(DEFAULT_JOB_COLUMNS)
  })

  it('formats row cell values without dropping falsy values', () => {
    const row = {
      priority: 0,
      retryCount: 0,
      retryLimit: 0,
      deadLetter: false,
      data: { tenantId: 'acme' },
      singletonKey: null,
    }

    expect(getRowCellValue(row, 'priority')).toBe('0')
    expect(getRowCellValue(row, 'retryCount')).toBe('0')
    expect(getRowCellValue(row, 'retryLimit')).toBe('0')
    expect(getRowCellValue(row, 'deadLetter')).toBe('false')
    expect(getRowCellValue(row, 'data')).toBe('{"tenantId":"acme"}')
    expect(getRowCellValue(row, 'singletonKey')).toBeNull()
  })
})
