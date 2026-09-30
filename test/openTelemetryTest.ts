import { expect, vi } from 'vitest'
import { context, propagation, SpanKind, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace'
import { AggregationTemporality, MeterProvider, MetricReader, type DataPoint, type Histogram, type MetricData } from '@opentelemetry/sdk-metrics'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { PgBoss } from '../src/index.ts'
import { delay } from '../src/tools.ts'

// Collects on demand, so a test reads the instruments right after the operations it made.
class CollectingMetricReader extends MetricReader {
  protected async onForceFlush () {}
  protected async onShutdown () {}
}

// A real SDK, registered globally the way an application registers it, so these tests cover what a
// user gets: the global tracer and meter providers, the AsyncLocalStorage context manager and the
// W3C propagator. Vitest runs each file in a process of its own, so the registration stays here.
const spans = new InMemorySpanExporter()
const metricReader = new CollectingMetricReader()
const sdk = new NodeSDK({
  spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
  metricReaders: [metricReader],
  // Without these the SDK builds OTLP log exporters from environment defaults.
  logRecordProcessors: [],
  instrumentations: []
})

const tracer = trace.getTracer('pg-boss-test')

const ATTR = {
  system: 'messaging.system',
  operation: 'messaging.operation.name',
  operationType: 'messaging.operation.type',
  destination: 'messaging.destination.name',
  messageId: 'messaging.message.id',
  batchCount: 'messaging.batch.message_count',
  errorType: 'error.type',
  retryCount: 'pgboss.job.retry_count'
}

beforeAll(() => sdk.start())
afterAll(() => sdk.shutdown())
beforeEach(() => spans.reset())

function isSpan (name: string, kind?: SpanKind) {
  return (span: ReadableSpan) => span.name === name && (kind === undefined || span.kind === kind)
}

function findSpans (predicate: (span: ReadableSpan) => boolean) {
  return spans.getFinishedSpans().filter(predicate)
}

async function waitForSpans (predicate: (span: ReadableSpan) => boolean, count = 1): Promise<ReadableSpan[]> {
  return vi.waitFor(() => {
    const found = findSpans(predicate)
    expect(found.length).toBeGreaterThanOrEqual(count)
    return found
  }, { timeout: 10_000, interval: 20 })
}

function parentOf (span: ReadableSpan) {
  return span.parentSpanContext?.spanId
}

function idOf (span: ReadableSpan) {
  return span.spanContext().spanId
}

function traceOf (span: ReadableSpan) {
  return span.spanContext().traceId
}

async function storedTraceContext (queue: string, id: string) {
  const { rows } = await helper.findJobs(ctx.schema, 'name = $1 AND id = $2', [queue, id])
  return rows[0]?.trace_context ?? null
}

function metric (resourceMetrics: Awaited<ReturnType<MetricReader['collect']>>['resourceMetrics'], name: string): MetricData | undefined {
  return resourceMetrics.scopeMetrics
    .filter(scope => scope.scope.name === 'pg-boss')
    .flatMap(scope => scope.metrics)
    .find(m => m.descriptor.name === name)
}

function pointsFor<T> (data: MetricData | undefined, attributes: Attributes): DataPoint<T>[] {
  return ((data?.dataPoints ?? []) as DataPoint<T>[])
    .filter(point => Object.entries(attributes).every(([key, value]) => point.attributes[key] === value))
}

describe('openTelemetry', function () {
  it('continues the trace of send() into the worker that processes the job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    const jobId = await tracer.startActiveSpan('http request', async span => {
      try {
        return await boss.send(ctx.schema, { hello: 'world' })
      } finally {
        span.end()
      }
    })
    assertTruthy(jobId)

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      tracer.startSpan('handler work').end()
    })

    const [processSpan] = await waitForSpans(isSpan(`process ${ctx.schema}`))
    const [request] = findSpans(isSpan('http request'))
    const [send] = findSpans(isSpan(`send ${ctx.schema}`))
    const [handler] = findSpans(isSpan('handler work'))
    const [complete] = findSpans(isSpan(`complete ${ctx.schema}`))

    expect(send.kind).toBe(SpanKind.PRODUCER)
    expect(parentOf(send)).toBe(idOf(request))
    expect(send.attributes).toMatchObject({
      [ATTR.system]: 'pg-boss',
      [ATTR.operation]: 'send',
      [ATTR.operationType]: 'send',
      [ATTR.destination]: ctx.schema,
      [ATTR.messageId]: jobId
    })

    expect(processSpan.kind).toBe(SpanKind.CONSUMER)
    expect(traceOf(processSpan)).toBe(traceOf(send))
    expect(parentOf(processSpan)).toBe(idOf(send))
    expect(processSpan.status.code).toBe(SpanStatusCode.UNSET)
    expect(processSpan.attributes).toMatchObject({
      [ATTR.operation]: 'process',
      [ATTR.operationType]: 'process',
      [ATTR.destination]: ctx.schema,
      [ATTR.messageId]: jobId,
      [ATTR.retryCount]: 0
    })

    expect(parentOf(handler)).toBe(idOf(processSpan))

    expect(complete.kind).toBe(SpanKind.CLIENT)
    expect(parentOf(complete)).toBe(idOf(processSpan))
    expect(complete.attributes).toMatchObject({ [ATTR.operationType]: 'settle', [ATTR.messageId]: jobId })

    const stored = await storedTraceContext(ctx.schema, jobId)
    expect(stored.traceparent).toBe(`00-${traceOf(send)}-${idOf(send)}-01`)
  })

  it('makes the baggage active at send() active in the handler', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    const baggage = propagation.createBaggage({ tenant: { value: 'acme' } })
    await context.with(propagation.setBaggage(context.active(), baggage), () => boss.send(ctx.schema))

    let tenant: string | undefined
    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      tenant = propagation.getActiveBaggage()?.getEntry('tenant')?.value
    })

    await waitForSpans(isSpan(`process ${ctx.schema}`))
    expect(tenant).toBe('acme')
  })

  it('records a perJobResults batch failed for a malformed result as an errored process span', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    await boss.send(ctx.schema, null, { retryLimit: 0 })

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5, perJobResults: true }, async () => 'not an array' as any)

    const [processSpan] = await waitForSpans(isSpan(`process ${ctx.schema}`))
    expect(processSpan.status.code).toBe(SpanStatusCode.ERROR)
    expect(processSpan.attributes[ATTR.errorType]).toBe('Error')
  })

  it('does not parent batches to the context work() was called in', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    await boss.send(ctx.schema)

    await tracer.startActiveSpan('registering request', async span => {
      await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {})
      span.end()
    })

    const [processSpan] = await waitForSpans(isSpan(`process ${ctx.schema}`))
    const [send] = findSpans(isSpan(`send ${ctx.schema}`))
    const [registering] = findSpans(isSpan('registering request'))

    expect(parentOf(processSpan)).toBe(idOf(send))
    expect(traceOf(processSpan)).not.toBe(traceOf(registering))
  })

  it('emits no spans while a worker polls an empty queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {})
    await delay(1500)

    expect(findSpans(span => span.attributes[ATTR.destination] === ctx.schema)).toEqual([])
  })

  it('records a failed attempt on its process span, and the retry stays in the same trace', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await testRetryTrace(ctx.boss)
  })

  it('keeps the trace across a retry on the distributed fail path', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__distributed: true })

    await testRetryTrace(ctx.boss)
  })

  async function testRetryTrace (boss: PgBoss) {
    const jobId = await boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 0 })
    assertTruthy(jobId)

    let attempts = 0
    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      attempts++
      if (attempts === 1) throw new Error('first attempt fails')
    })

    const processSpans = await waitForSpans(isSpan(`process ${ctx.schema}`), 2)
    const [send] = findSpans(isSpan(`send ${ctx.schema}`))
    const [failed, retried] = processSpans.sort((a, b) => Number(a.attributes[ATTR.retryCount]) - Number(b.attributes[ATTR.retryCount]))

    for (const span of [failed, retried]) {
      expect(traceOf(span)).toBe(traceOf(send))
      expect(parentOf(span)).toBe(idOf(send))
    }

    expect(failed.attributes[ATTR.retryCount]).toBe(0)
    expect(failed.status).toEqual({ code: SpanStatusCode.ERROR, message: 'first attempt fails' })
    expect(failed.attributes[ATTR.errorType]).toBe('Error')
    expect(failed.events.map(event => event.name)).toContain('exception')

    expect(retried.attributes[ATTR.retryCount]).toBe(1)
    expect(retried.status.code).toBe(SpanStatusCode.UNSET)

    const [fail] = findSpans(isSpan(`fail ${ctx.schema}`))
    expect(parentOf(fail)).toBe(idOf(failed))
  }

  it('links a dead lettered job and its redrive back to the original send', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const boss = ctx.boss
    const deadLetter = `${ctx.schema}_dlq`

    await boss.createQueue(deadLetter)
    await boss.createQueue(ctx.schema, { deadLetter })

    const jobId = await boss.send(ctx.schema, null, { retryLimit: 0 })
    assertTruthy(jobId)
    const [send] = findSpans(isSpan(`send ${ctx.schema}`))

    const [job] = await boss.fetch(ctx.schema)
    await boss.fail(ctx.schema, job)

    const [dlqRow] = (await helper.findJobs(ctx.schema, 'name = $1', [deadLetter])).rows
    expect(dlqRow.trace_context).toEqual(await storedTraceContext(ctx.schema, jobId))

    expect(await boss.redrive(deadLetter)).toBe(1)
    spans.reset()

    const [redriven] = await helper.fetchWithRetry(boss, ctx.schema)
    expect(redriven.id).not.toBe(jobId)

    const [receive] = findSpans(isSpan(`receive ${ctx.schema}`))
    expect(receive.links.map(link => link.context.spanId)).toEqual([idOf(send)])
  })

  it('processes a batch in one span linked to the send of every job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    for (let i = 0; i < 3; i++) {
      await boss.send(ctx.schema, { i })
    }

    const sends = findSpans(isSpan(`send ${ctx.schema}`))
    expect(sends).toHaveLength(3)

    await boss.work(ctx.schema, { batchSize: 3, pollingIntervalSeconds: 0.5 }, async () => {})

    const [processSpan] = await waitForSpans(isSpan(`process ${ctx.schema}`))

    expect(processSpan.parentSpanContext).toBeUndefined()
    expect(processSpan.attributes[ATTR.batchCount]).toBe(3)
    expect(processSpan.attributes[ATTR.messageId]).toBeUndefined()
    expect(processSpan.links.map(link => link.context.spanId).sort()).toEqual(sends.map(idOf).sort())
  })

  it('records fetch() as a receive span linked to the sends, and complete() as a settle span', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    const jobId = await boss.send(ctx.schema)
    const [send] = findSpans(isSpan(`send ${ctx.schema}`))

    const jobs = await boss.fetch(ctx.schema)
    expect(jobs.map(job => job.id)).toEqual([jobId])
    expect(Object.keys(jobs[0])).not.toContain('__traceContext')

    await boss.complete(ctx.schema, jobs[0])

    const [receive] = findSpans(isSpan(`receive ${ctx.schema}`))
    expect(receive.kind).toBe(SpanKind.CLIENT)
    expect(receive.attributes).toMatchObject({ [ATTR.operationType]: 'receive', [ATTR.messageId]: jobId })
    expect(receive.links.map(link => link.context.spanId)).toEqual([idOf(send)])

    const [complete] = findSpans(isSpan(`complete ${ctx.schema}`))
    expect(complete.attributes).toMatchObject({ [ATTR.operation]: 'complete', [ATTR.operationType]: 'settle', [ATTR.messageId]: jobId })

    await boss.fetch(ctx.schema)
    const [, emptyReceive] = findSpans(isSpan(`receive ${ctx.schema}`))
    expect(emptyReceive.attributes[ATTR.batchCount]).toBe(0)
    expect(emptyReceive.links).toEqual([])
  })

  it('records cancel() and deleteJob() as settle spans', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    const first = await boss.send(ctx.schema)
    const second = await boss.send(ctx.schema)
    assertTruthy(first)
    assertTruthy(second)

    await boss.cancel(ctx.schema, first)
    await boss.deleteJob(ctx.schema, [first, second])

    const [cancel] = findSpans(isSpan(`cancel ${ctx.schema}`))
    const [remove] = findSpans(isSpan(`delete ${ctx.schema}`))

    expect(cancel.attributes[ATTR.messageId]).toBe(first)
    expect(remove.attributes[ATTR.batchCount]).toBe(2)
  })

  it('records insert() as one send span that every inserted job continues', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    await boss.insert(ctx.schema, [{ data: { a: 1 } }, { data: { a: 2 } }])

    const [insert] = findSpans(isSpan(`insert ${ctx.schema}`, SpanKind.PRODUCER))
    expect(insert.attributes[ATTR.batchCount]).toBe(2)

    const jobs = await boss.fetch(ctx.schema, { batchSize: 2 })
    expect(jobs).toHaveLength(2)

    const [receive] = findSpans(isSpan(`receive ${ctx.schema}`))
    expect(receive.links.map(link => link.context.spanId)).toEqual([idOf(insert), idOf(insert)])
  })

  it('records upsert() as a send span that only an inserted job continues', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    const inserted = await boss.upsert(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    const [insertSpan] = findSpans(isSpan(`upsert ${ctx.schema}`, SpanKind.PRODUCER))
    expect(inserted.inserted).toBe(1)
    expect(insertSpan.attributes[ATTR.messageId]).toBe(inserted.jobs[0])

    spans.reset()
    const updated = await boss.upsert(ctx.schema, { v: 2 }, { singletonKey: 'k' })
    const [updateSpan] = findSpans(isSpan(`upsert ${ctx.schema}`, SpanKind.PRODUCER))
    expect(updated.updated).toBe(1)
    expect(updateSpan.attributes[ATTR.messageId]).toBeUndefined()

    const stored = await storedTraceContext(ctx.schema, inserted.jobs[0])
    expect(stored.traceparent).toContain(idOf(insertSpan))

    const { resourceMetrics } = await metricReader.collect()
    const sent = pointsFor<number>(metric(resourceMetrics, 'messaging.client.sent.messages'), { [ATTR.destination]: ctx.schema })
    expect(sent.map(point => point.value)).toEqual([1])
  })

  it('ignores a __traceContext passed to insert()', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, openTelemetry: { enabled: false } })

    await ctx.boss.insert(ctx.schema, [{ data: {}, __traceContext: { traceparent: '00-bogus' } } as any])

    const { rows } = await helper.findJobs(ctx.schema, 'name = $1', [ctx.schema])
    expect(rows[0].trace_context).toBeNull()
  })

  it('records flow() as one send span, continued by every job in the flow', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    const flow = await boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
    ])

    const [flowSpan] = findSpans(isSpan(`flow ${ctx.schema}`, SpanKind.PRODUCER))
    expect(flowSpan.attributes[ATTR.batchCount]).toBe(2)

    for (const id of [flow.parent, flow.child]) {
      const stored = await storedTraceContext(ctx.schema, id)
      expect(stored.traceparent).toContain(idOf(flowSpan))
    }
  })

  it('records publish() as a send span that parents the send to each subscribed queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss
    const event = `${ctx.schema}_event`

    await boss.subscribe(event, ctx.schema)
    await boss.publish(event, { hi: true })

    const [publish] = findSpans(isSpan(`publish ${event}`, SpanKind.PRODUCER))
    const [send] = findSpans(isSpan(`send ${ctx.schema}`))

    expect(publish.attributes[ATTR.destination]).toBe(event)
    expect(parentOf(send)).toBe(idOf(publish))

    // The job is counted once, by the send it went through.
    const { resourceMetrics } = await metricReader.collect()
    const sent = metric(resourceMetrics, 'messaging.client.sent.messages')
    expect(pointsFor(sent, { [ATTR.destination]: event })).toEqual([])
    expect(pointsFor<number>(sent, { [ATTR.destination]: ctx.schema }).map(point => point.value)).toEqual([1])
  })

  it('records a send that throws as an errored span', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(ctx.boss.send(`${ctx.schema}_missing`)).rejects.toThrow()

    const [send] = findSpans(isSpan(`send ${ctx.schema}_missing`))
    expect(send.status.code).toBe(SpanStatusCode.ERROR)
    expect(send.attributes[ATTR.errorType]).toBe('Error')
  })

  it('records the messaging metrics for sends, deliveries, processing and settles', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    await boss.send(ctx.schema, null, { retryLimit: 0 })
    await boss.send(ctx.schema, null, { retryLimit: 0 })

    let attempts = 0
    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      attempts++
      if (attempts === 1) throw new Error('boom')
    })

    await waitForSpans(isSpan(`process ${ctx.schema}`), 2)

    const { resourceMetrics } = await metricReader.collect()
    const queue = { [ATTR.destination]: ctx.schema }

    const sent = pointsFor<number>(metric(resourceMetrics, 'messaging.client.sent.messages'), queue)
    expect(sent).toHaveLength(1)
    expect(sent[0].value).toBe(2)
    expect(sent[0].attributes).toEqual({ ...queue, [ATTR.system]: 'pg-boss', [ATTR.operation]: 'send', [ATTR.operationType]: 'send' })

    const consumed = pointsFor<number>(metric(resourceMetrics, 'messaging.client.consumed.messages'), queue)
    expect(consumed.reduce((sum, point) => sum + point.value, 0)).toBe(2)

    const processDuration = metric(resourceMetrics, 'messaging.process.duration')
    expect(processDuration?.descriptor.unit).toBe('s')
    const failedProcesses = pointsFor<Histogram>(processDuration, { ...queue, [ATTR.errorType]: 'Error' })
    const okProcesses = pointsFor<Histogram>(processDuration, queue).filter(point => point.attributes[ATTR.errorType] === undefined)
    expect(failedProcesses[0].value.count).toBe(1)
    expect(okProcesses[0].value.count).toBe(1)

    const operations = pointsFor<Histogram>(metric(resourceMetrics, 'messaging.client.operation.duration'), queue)
    const countOf = (operation: string) => operations
      .filter(point => point.attributes[ATTR.operation] === operation)
      .reduce((sum, point) => sum + point.value.count, 0)
    expect(countOf('send')).toBe(2)
    expect(countOf('complete')).toBe(1)
    expect(countOf('fail')).toBe(1)

    const queueJobs = pointsFor<number>(metric(resourceMetrics, 'pgboss.queue.jobs'), queue)
    expect(queueJobs.map(point => point.attributes['pgboss.job.state']).sort()).toEqual(['active', 'deferred', 'failed', 'ready'])
  })

  it('reports queue gauges through the meterProvider it is given, until it stops', async function () {
    // Delta temporality, so a series nothing observed in an interval is absent from that collection
    // rather than repeated from the last one.
    const reader = new CollectingMetricReader({ aggregationTemporalitySelector: () => AggregationTemporality.DELTA })
    const meterProvider = new MeterProvider({ readers: [reader] })

    ctx.boss = await helper.start({ ...ctx.bossConfig, openTelemetry: { meterProvider } })

    // The queue cache loads a queue created after start() on its first use.
    await ctx.boss.send(ctx.schema)

    const gaugeFor = async () => pointsFor<number>(metric((await reader.collect()).resourceMetrics, 'pgboss.queue.jobs'), { [ATTR.destination]: ctx.schema })

    expect((await gaugeFor()).map(point => point.attributes['pgboss.job.state']).sort()).toEqual(['active', 'deferred', 'failed', 'ready'])
    expect(pointsFor(metric((await metricReader.collect()).resourceMetrics, 'pgboss.queue.jobs'), { [ATTR.destination]: ctx.schema })).toEqual([])

    await ctx.boss.stop({ graceful: false })
    ctx.boss = undefined

    expect(await gaugeFor()).toEqual([])

    await meterProvider.shutdown()
  })

  it('emits nothing and stores no trace context when disabled', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, openTelemetry: { enabled: false } })
    const boss = ctx.boss

    const jobId = await tracer.startActiveSpan('http request', async span => {
      try {
        return await boss.send(ctx.schema)
      } finally {
        span.end()
      }
    })
    assertTruthy(jobId)

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {})
    await vi.waitFor(async () => expect((await boss.getJobById(ctx.schema, jobId))?.state).toBe('completed'), { timeout: 10_000 })

    expect(findSpans(span => span.instrumentationScope.name === 'pg-boss' && span.attributes[ATTR.destination] === ctx.schema)).toEqual([])
    expect(await storedTraceContext(ctx.schema, jobId)).toBeNull()

    const { resourceMetrics } = await metricReader.collect()
    expect(pointsFor(metric(resourceMetrics, 'messaging.client.sent.messages'), { [ATTR.destination]: ctx.schema })).toEqual([])
  })

  it('without propagateContext, stores no trace context and the worker starts a trace of its own', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, openTelemetry: { propagateContext: false } })
    const boss = ctx.boss

    const jobId = await boss.send(ctx.schema)
    assertTruthy(jobId)

    expect(await storedTraceContext(ctx.schema, jobId)).toBeNull()

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {})

    const [processSpan] = await waitForSpans(isSpan(`process ${ctx.schema}`))
    const [send] = findSpans(isSpan(`send ${ctx.schema}`))

    expect(processSpan.parentSpanContext).toBeUndefined()
    expect(traceOf(processSpan)).not.toBe(traceOf(send))
  })

  it('creates spans with the tracerProvider it is given instead of the global one', async function () {
    const ownSpans = new InMemorySpanExporter()
    const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: ownSpans })] })

    ctx.boss = await helper.start({ ...ctx.bossConfig, openTelemetry: { tracerProvider } })

    await ctx.boss.send(ctx.schema)

    expect(ownSpans.getFinishedSpans().map(span => span.name)).toContain(`send ${ctx.schema}`)
    expect(findSpans(isSpan(`send ${ctx.schema}`))).toEqual([])

    await tracerProvider.shutdown()
  })

  it('rejects an invalid openTelemetry option', function () {
    expect(() => new PgBoss({ ...ctx.bossConfig, openTelemetry: 'yes' as any })).toThrow('openTelemetry must be an object')
    expect(() => new PgBoss({ ...ctx.bossConfig, openTelemetry: { enabled: 'no' as any } })).toThrow('openTelemetry.enabled must be a boolean')
    expect(() => new PgBoss({ ...ctx.bossConfig, openTelemetry: { tracerProvider: {} as any } })).toThrow('tracerProvider must implement getTracer()')
  })
})
