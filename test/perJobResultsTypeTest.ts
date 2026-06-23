import { describe, it, expectTypeOf } from 'vitest'
import type { PgBoss } from '../src/index.ts'
import type {
  WorkHandlerFor,
  WorkHandler,
  WorkWithMetadataHandler,
  PerJobWorkHandler,
  PerJobWorkWithMetadataHandler,
  WorkOptions
} from '../src/index.ts'

// These assertions pin the compile-time contract of `work()`'s handler selection so a future change
// to the overloads or to WorkHandlerFor can't silently loosen per-job typing or regress the ordinary
// (non-perJobResults) API. Verified by `npm run tsc` and by vitest's typecheck pass.

type Req = { n: number }

describe('WorkHandlerFor resolves the handler from the inferred options', () => {
  it('a literal perJobResults: true demands the per-job handler', () => {
    expectTypeOf<WorkHandlerFor<{ perJobResults: true }, Req>>().toEqualTypeOf<PerJobWorkHandler<Req>>()
  })

  it('perJobResults + includeMetadata demands the per-job metadata handler', () => {
    expectTypeOf<WorkHandlerFor<{ perJobResults: true; includeMetadata: true }, Req>>()
      .toEqualTypeOf<PerJobWorkWithMetadataHandler<Req>>()
  })

  it('includeMetadata alone keeps the metadata handler', () => {
    expectTypeOf<WorkHandlerFor<{ includeMetadata: true }, Req>>().toEqualTypeOf<WorkWithMetadataHandler<Req>>()
  })

  it('plain options keep the default single-output handler', () => {
    expectTypeOf<WorkHandlerFor<{ batchSize: 5 }, Req>>().toEqualTypeOf<WorkHandler<Req>>()
    expectTypeOf<WorkHandlerFor<Record<string, never>, Req>>().toEqualTypeOf<WorkHandler<Req>>()
  })

  it('an explicit perJobResults: false keeps the default handler', () => {
    expectTypeOf<WorkHandlerFor<{ perJobResults: false }, Req>>().toEqualTypeOf<WorkHandler<Req>>()
  })

  it('a non-literal boolean perJobResults stays permissive (dynamically-built options)', () => {
    // The crux of the no-regression guarantee: options whose perJobResults is `boolean` (not the
    // literal `true`) must NOT be forced into the per-job handler.
    expectTypeOf<WorkHandlerFor<{ perJobResults: boolean }, Req>>().toEqualTypeOf<WorkHandler<Req>>()
    expectTypeOf<WorkHandlerFor<WorkOptions, Req>>().toEqualTypeOf<WorkHandler<Req>>()
  })
})

// Compile-only: never invoked at runtime. tsc/typecheck verify that real work() calls accept valid
// handlers and reject malformed per-job handlers end to end (overload + inference + const O), not just
// the WorkHandlerFor mapping in isolation.
export async function workCallTypeContract (boss: PgBoss): Promise<void> {
  // --- accepted: ordinary handlers and dynamically-built options ---
  await boss.work('q', async () => 'done')
  await boss.work('q', { batchSize: 5 }, async jobs => jobs.length)
  await boss.work('q', { includeMetadata: true }, async jobs => jobs[0]?.priority)
  const opts: WorkOptions = { batchSize: 5 }
  await boss.work('q', opts, async jobs => jobs.length)
  const flag: boolean = opts.batchSize === 5
  await boss.work('q', { perJobResults: flag }, async jobs => jobs.length)

  // --- accepted: valid per-job handlers (union returns and inline literals, no `as const` needed) ---
  await boss.work('q', { perJobResults: true }, async jobs =>
    jobs.map(job => job.id > 'm'
      ? { id: job.id, status: 'completed', output: { ok: true } }
      : { id: job.id, status: 'failed', output: new Error('x') }))
  await boss.work('q', { perJobResults: true, includeMetadata: true }, async jobs =>
    jobs.map(job => ({ id: job.id, status: 'deadletter' as const, output: job.priority })))

  // --- rejected: a per-job handler that does not resolve with an array ---
  // @ts-expect-error a perJobResults handler must resolve with a JobResult[]
  await boss.work('q', { perJobResults: true }, async () => ({ not: 'an array' }))

  // --- rejected: an unrecognized JobResultStatus ---
  await boss.work('q', { perJobResults: true }, async jobs =>
    // @ts-expect-error 'skipped' is not a valid JobResultStatus
    jobs.map(job => ({ id: job.id, status: 'skipped' as const })))

  // --- rejected: opting into perJobResults but returning a plain single output ---
  // @ts-expect-error a perJobResults handler must resolve with a JobResult[], not a scalar
  await boss.work('q', { perJobResults: true }, async jobs => jobs.length)
}
