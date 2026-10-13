import { describe, it, expect } from 'vitest'
import pg from 'pg'
import { ctx, createTestQueue, updateQueueStats, insertTestWarning, insertTestBam, getBoss } from './helpers'
import { getQueuePage, getSchedules, getWarnings, getBamEntries, getRecentJobs, getJobs, type ListPage, type PageOptions } from '~/lib/queries.server'
import { decodeCursor, encodeCursor, keysetCondition, type Key } from '~/lib/keyset.server'

type Read<T> = (options: PageOptions) => Promise<ListPage<T>>

// Read a list one small page at a time, forward to its end and back to its start, and check both
// walks against one read of the whole list: every row once, in the same order.
async function expectWalksMatch<T> (read: Read<T>, id: (row: T) => string) {
  const whole = (await read({ limit: 1000 })).rows.map(id)
  expect(whole.length).toBeGreaterThan(3)

  const pages: ListPage<T>[] = [await read({ limit: 2 })]
  while (pages.at(-1)!.hasNextPage) {
    pages.push(await read({ limit: 2, cursor: { after: pages.at(-1)!.nextCursor } }))
  }
  expect(pages.flatMap(p => p.rows.map(id))).toEqual(whole)

  const back: ListPage<T>[] = [pages.at(-1)!]
  while (back.at(-1)!.hasPrevPage) {
    back.push(await read({ limit: 2, cursor: { before: back.at(-1)!.prevCursor } }))
  }
  expect(back.reverse().flatMap(p => p.rows.map(id))).toEqual(whole)
}

async function withPool (fn: (pool: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: ctx.connectionString })
  try { await fn(pool) } finally { await pool.end() }
}

describe('keyset paging', () => {
  it('pages recent jobs across queues and within one, through created_on ties', async () => {
    for (const name of ['alpha', 'beta', 'gamma']) {
      await createTestQueue(name)
      // One insert() per queue: its jobs share created_on.
      await getBoss().insert(name, Array.from({ length: 5 }, (_, i) => ({ data: { i } })))
    }
    const key = (j: { name: string; id: string }) => `${j.name}/${j.id}`

    await expectWalksMatch((o) => getRecentJobs(ctx.connectionString, ctx.schema, { ...o, state: 'all' }), key)
    await expectWalksMatch((o) => getRecentJobs(ctx.connectionString, ctx.schema, { ...o, state: 'all', queues: ['alpha', 'gamma'] }), key)
    await expectWalksMatch((o) => getJobs(ctx.connectionString, ctx.schema, 'beta', { ...o, state: 'all' }), key)

    const selected = (await getRecentJobs(ctx.connectionString, ctx.schema, { limit: 100, queues: ['alpha', 'gamma'] })).rows
    expect(new Set(selected.map(j => j.name))).toEqual(new Set(['alpha', 'gamma']))
  })

  it('pages finished jobs newest finished first, through completed_on ties', async () => {
    for (const name of ['alpha', 'beta']) {
      await createTestQueue(name)
      await getBoss().insert(name, Array.from({ length: 6 }, (_, i) => ({ data: { i } })))
    }
    // Finish order runs against creation order, with pairs finishing together.
    await withPool(pool => pool.query(`
      UPDATE ${ctx.schema}.job
      SET state = CASE WHEN (data->>'i')::int = 5 THEN 'cancelled' ELSE 'completed' END::${ctx.schema}.job_state,
        completed_on = '2026-01-01'::timestamptz - ((data->>'i')::int / 2) * interval '1 minute'
    `).then(() => undefined))
    const key = (j: { name: string; id: string }) => `${j.name}/${j.id}`

    await expectWalksMatch((o) => getRecentJobs(ctx.connectionString, ctx.schema, { ...o, state: 'completed' }), key)
    await expectWalksMatch((o) => getJobs(ctx.connectionString, ctx.schema, 'beta', { ...o, state: 'completed' }), key)

    const rows = (await getRecentJobs(ctx.connectionString, ctx.schema, { limit: 100, state: 'completed' })).rows
    const finished = rows.map(j => new Date(j.completedOn!).getTime())
    expect(rows).toHaveLength(10)
    expect(finished).toEqual([...finished].sort((a, b) => b - a))
  })

  it('pages queues sorted by a column with ties, both ways', async () => {
    const totals = [5, 5, 1, 9, 5, 1, 9]
    for (const [i, total] of totals.entries()) {
      await createTestQueue(`q${i}`)
      await updateQueueStats(ctx.schema, `q${i}`, { totalCount: total })
    }

    for (const dir of ['asc', 'desc']) {
      await expectWalksMatch((o) => getQueuePage(ctx.connectionString, ctx.schema, { ...o, sort: 'total', dir }), q => q.name)
    }
    await expectWalksMatch((o) => getQueuePage(ctx.connectionString, ctx.schema, { ...o, sort: 'storage', dir: 'desc' }), q => q.name)
  })

  it('pages schedules sorted by a nullable timezone', async () => {
    await createTestQueue('sched-q')
    await withPool(async (pool) => {
      for (const [i, tz] of ['UTC', null, 'America/Chicago', null, 'UTC', 'Asia/Tokyo'].entries()) {
        await pool.query(`INSERT INTO ${ctx.schema}.schedule (name, key, cron, timezone) VALUES ('sched-q', $1, '0 * * * *', $2)`, [`k${i}`, tz])
      }
    })

    for (const dir of ['asc', 'desc']) {
      await expectWalksMatch((o) => getSchedules(ctx.connectionString, ctx.schema, { ...o, sort: 'timezone', dir }), s => s.key)
    }
  })

  it('pages warnings sorted ascending against a descending tiebreak', async () => {
    for (let i = 0; i < 7; i++) await insertTestWarning(ctx.schema, i % 2 ? 'slow_query' : 'clock_skew', `m${i}`)
    // Two warnings in one instant, so created_on ties and id has to decide.
    await withPool(async (pool) => {
      await pool.query(`UPDATE ${ctx.schema}.warning SET created_on = (SELECT min(created_on) FROM ${ctx.schema}.warning) WHERE message IN ('m3', 'm4')`)
    })

    await expectWalksMatch((o) => getWarnings(ctx.connectionString, ctx.schema, { ...o, sort: 'created', dir: 'asc' }), w => String(w.id))
    await expectWalksMatch((o) => getWarnings(ctx.connectionString, ctx.schema, { ...o, sort: 'type', dir: 'desc' }), w => String(w.id))
    await expectWalksMatch((o) => getWarnings(ctx.connectionString, ctx.schema, o), w => String(w.id))
  })

  it('pages migrations sorted by a nullable start time', async () => {
    for (let i = 0; i < 6; i++) await insertTestBam(ctx.schema, { name: `mig-${i}`, version: 40 + (i % 3) })
    await withPool(async (pool) => {
      await pool.query(`UPDATE ${ctx.schema}.bam SET started_on = now() - interval '1 hour' WHERE name IN ('mig-1', 'mig-4')`)
    })

    for (const dir of ['asc', 'desc']) {
      await expectWalksMatch((o) => getBamEntries(ctx.connectionString, ctx.schema, { ...o, sort: 'started', dir }), e => e.id)
    }
    await expectWalksMatch((o) => getBamEntries(ctx.connectionString, ctx.schema, o), e => e.id)
  })
})

describe('keyset cursors', () => {
  const keys: Key[] = [
    { expr: 'created_on', type: 'timestamptz', desc: true },
    { expr: 'id', type: 'uuid', desc: true },
  ]

  it('round-trips the key values', () => {
    const values = ['2026-10-13 12:00:00.123456-05', '0f8d2c9e-6b1a-4d3e-9f2a-1c3b5d7e9f01']
    expect(decodeCursor(encodeCursor(values), keys)).toEqual(values)
  })

  it('rejects a cursor that does not fit the keys', () => {
    expect(decodeCursor('not-a-cursor', keys)).toBeNull()
    expect(decodeCursor(encodeCursor(['2026-10-13 12:00:00-05']), keys)).toBeNull()
    expect(decodeCursor(encodeCursor(['yesterday', '0f8d2c9e-6b1a-4d3e-9f2a-1c3b5d7e9f01']), keys)).toBeNull()
    expect(decodeCursor(encodeCursor(['2026-10-13 12:00:00-05', "x'; DROP TABLE job; --"]), keys)).toBeNull()
  })

  it('compares keys that run one way as a row, and mixed ones as an OR chain', () => {
    expect(keysetCondition(keys, 3, false)).toBe('(created_on, id) < ($3::timestamptz, $4::uuid)')
    expect(keysetCondition(keys, 1, true)).toBe('(created_on, id) > ($1::timestamptz, $2::uuid)')

    const mixed: Key[] = [{ ...keys[0], desc: false }, keys[1]]
    expect(keysetCondition(mixed, 1, false))
      .toBe('((created_on > $1::timestamptz) OR (created_on = $1::timestamptz AND id < $2::uuid))')
  })
})
