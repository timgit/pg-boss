import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Link,
  type Meter,
  type MeterProvider,
  type ObservableGauge,
  type ObservableResult,
  type Span,
  type SpanContext,
  type Tracer
} from '@opentelemetry/api'
import packageJson from '../package.json' with { type: 'json' }
import type * as types from './types.ts'

// The OpenTelemetry messaging semantic conventions, copied rather than imported: the messaging
// attributes still live in the unstable "incubating" entry point of @opentelemetry/semantic-conventions,
// which is not meant to be depended on by libraries.
// https://opentelemetry.io/docs/specs/semconv/messaging/
export const ATTR = {
  messagingSystem: 'messaging.system',
  operationName: 'messaging.operation.name',
  operationType: 'messaging.operation.type',
  destinationName: 'messaging.destination.name',
  messageId: 'messaging.message.id',
  batchMessageCount: 'messaging.batch.message_count',
  errorType: 'error.type',
  retryCount: 'pgboss.job.retry_count',
  jobState: 'pgboss.job.state'
} as const

export const METRIC = {
  operationDuration: 'messaging.client.operation.duration',
  sentMessages: 'messaging.client.sent.messages',
  consumedMessages: 'messaging.client.consumed.messages',
  processDuration: 'messaging.process.duration',
  queueJobs: 'pgboss.queue.jobs'
} as const

export const MESSAGING_SYSTEM = 'pg-boss'
export const INSTRUMENTATION_SCOPE = 'pg-boss'

// The bucket boundaries the messaging conventions recommend for their duration histograms.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]

type OperationType = 'send' | 'receive' | 'process' | 'settle'

// The trace context of the send() that created a job, as the propagator wrote it.
export type TraceCarrier = Record<string, string>

interface Instruments {
  operationDuration: Histogram
  sentMessages: Counter
  consumedMessages: Counter
  processDuration: Histogram
  queueJobs: ObservableGauge
}

interface CarrierJob {
  id: string
  retryCount?: number
}

type QueueSnapshot = () => Record<string, types.QueueResult> | null

function errorType (err: unknown): string {
  if (err instanceof Error) return err.constructor.name
  return '_OTHER'
}

function spanName (operation: string, destination: string | null) {
  return destination ? `${operation} ${destination}` : operation
}

function baseAttributes (operation: string, type: OperationType, destination: string | null): Attributes {
  const attributes: Attributes = {
    [ATTR.messagingSystem]: MESSAGING_SYSTEM,
    [ATTR.operationName]: operation,
    [ATTR.operationType]: type
  }

  if (destination) attributes[ATTR.destinationName] = destination

  return attributes
}

function metricAttributes (attributes: Attributes, err?: unknown): Attributes {
  const { [ATTR.messageId]: _id, [ATTR.batchMessageCount]: _count, [ATTR.retryCount]: _retry, ...rest } = attributes
  return err === undefined ? rest : { ...rest, [ATTR.errorType]: errorType(err) }
}

function recordError (span: Span, err: unknown) {
  span.setAttribute(ATTR.errorType, errorType(err))
  if (err instanceof Error) {
    span.recordException(err)
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
  } else {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
  }
}

function seconds (startedAt: number) {
  return (performance.now() - startedAt) / 1000
}

class Telemetry {
  readonly enabled: boolean
  readonly #propagate: boolean
  readonly #tracer: Tracer
  readonly #meterProvider: MeterProvider | undefined
  readonly #queues: QueueSnapshot
  #instrumentsFor: MeterProvider | null = null
  #instruments: Instruments | null = null
  #observing = false

  constructor (options: types.OpenTelemetryOptions = {}, queues: QueueSnapshot) {
    this.enabled = options.enabled !== false
    this.#propagate = this.enabled && options.propagateContext !== false
    this.#tracer = (options.tracerProvider ?? trace.getTracerProvider()).getTracer(INSTRUMENTATION_SCOPE, packageJson.version)
    this.#meterProvider = options.meterProvider
    this.#queues = queues
  }

  // The global meter provider has no proxy the way the tracer provider does: a meter taken before
  // an SDK registers stays a no-op forever. Resolving the provider on every use and rebuilding the
  // instruments when it changes is what lets an SDK started after pg-boss still receive metrics.
  #getInstruments (): Instruments | null {
    if (!this.enabled) return null

    const provider = this.#meterProvider ?? metrics.getMeterProvider()

    if (provider === this.#instrumentsFor && this.#instruments) return this.#instruments

    this.#instruments?.queueJobs.removeCallback(this.#observeQueues)

    const meter: Meter = provider.getMeter(INSTRUMENTATION_SCOPE, packageJson.version)

    this.#instrumentsFor = provider
    this.#instruments = {
      operationDuration: meter.createHistogram(METRIC.operationDuration, {
        description: 'Duration of messaging operation initiated by a producer or consumer client.',
        unit: 's',
        advice: { explicitBucketBoundaries: DURATION_BUCKETS }
      }),
      sentMessages: meter.createCounter(METRIC.sentMessages, {
        description: 'Number of messages producer attempted to send to the broker.',
        unit: '{message}'
      }),
      consumedMessages: meter.createCounter(METRIC.consumedMessages, {
        description: 'Number of messages that were delivered to the application.',
        unit: '{message}'
      }),
      processDuration: meter.createHistogram(METRIC.processDuration, {
        description: 'Duration of processing operation.',
        unit: 's',
        advice: { explicitBucketBoundaries: DURATION_BUCKETS }
      }),
      queueJobs: meter.createObservableGauge(METRIC.queueJobs, {
        description: 'Jobs in a queue by state, as of the last queue cache refresh.',
        unit: '{job}'
      })
    }

    if (this.#observing) {
      this.#instruments.queueJobs.addCallback(this.#observeQueues)
    }

    return this.#instruments
  }

  #observeQueues = (result: ObservableResult) => {
    const queues = this.#queues()
    if (!queues) return

    for (const queue of Object.values(queues)) {
      const attributes = { [ATTR.messagingSystem]: MESSAGING_SYSTEM, [ATTR.destinationName]: queue.name }
      result.observe(queue.deferredCount ?? 0, { ...attributes, [ATTR.jobState]: 'deferred' })
      result.observe(queue.readyCount ?? 0, { ...attributes, [ATTR.jobState]: 'ready' })
      result.observe(queue.activeCount ?? 0, { ...attributes, [ATTR.jobState]: 'active' })
      result.observe(queue.failedCount ?? 0, { ...attributes, [ATTR.jobState]: 'failed' })
    }
  }

  // Starts reporting pgboss.queue.jobs from the queue cache. Called by start(), undone by stop().
  observeQueues () {
    if (!this.enabled || this.#observing) return
    this.#observing = true
    this.#getInstruments()?.queueJobs.addCallback(this.#observeQueues)
  }

  unobserveQueues () {
    if (!this.#observing) return
    this.#observing = false
    this.#instruments?.queueJobs.removeCallback(this.#observeQueues)
  }

  // Moves the queue gauge to a meter provider registered after start(), which otherwise waits for
  // the next send, fetch or settle. Called on each queue cache refresh.
  refreshInstruments () {
    if (this.#observing) this.#getInstruments()
  }

  /**
   * Runs a job-creating operation in a PRODUCER span and hands `fn` the trace context to store on
   * each job it inserts, or null when there is nothing to propagate. `attempted` is the number of
   * jobs it creates itself, counted whether or not they land. A function instead counts from the
   * result, and counts nothing when `fn` throws.
   */
  async send<T> (
    operation: string,
    destination: string | null,
    attempted: number | ((result: T) => number),
    fn: (carrier: TraceCarrier | null) => Promise<T>,
    idsOf: (result: T) => string[] | null = () => null
  ): Promise<T> {
    if (!this.enabled) return fn(null)

    const attributes = baseAttributes(operation, 'send', destination)
    if (typeof attempted === 'number' && attempted > 1) attributes[ATTR.batchMessageCount] = attempted

    const span = this.#tracer.startSpan(spanName(operation, destination), { kind: SpanKind.PRODUCER, attributes })
    const spanContext = trace.setSpan(context.active(), span)
    const startedAt = performance.now()

    let carrier: TraceCarrier | null = null
    if (this.#propagate) {
      const injected: TraceCarrier = {}
      propagation.inject(spanContext, injected)
      carrier = Object.keys(injected).length > 0 ? injected : null
    }

    try {
      const result = await context.with(spanContext, () => fn(carrier))
      const ids = idsOf(result)
      const sent = typeof attempted === 'number' ? attempted : attempted(result)

      if (sent === 1 && ids?.length === 1) {
        span.setAttribute(ATTR.messageId, ids[0])
      }

      this.#recordSend(startedAt, sent, metricAttributes(attributes))

      return result
    } catch (err) {
      recordError(span, err)
      this.#recordSend(startedAt, typeof attempted === 'number' ? attempted : 0, metricAttributes(attributes, err))
      throw err
    } finally {
      span.end()
    }
  }

  #recordSend (startedAt: number, attempted: number, attributes: Attributes) {
    const instruments = this.#getInstruments()
    instruments?.operationDuration.record(seconds(startedAt), attributes)
    if (attempted > 0) instruments?.sentMessages.add(attempted, attributes)
  }

  /**
   * Wraps a fetch() the application made itself in a CLIENT `receive` span, linked to the send of
   * every job it returned.
   */
  async receive<J extends CarrierJob> (destination: string, fn: () => Promise<J[]>, carrierOf: (job: J) => TraceCarrier | null | undefined): Promise<J[]> {
    if (!this.enabled) return fn()

    const attributes = baseAttributes('receive', 'receive', destination)
    const span = this.#tracer.startSpan(spanName('receive', destination), { kind: SpanKind.CLIENT, attributes })
    const startedAt = performance.now()

    try {
      const jobs = await context.with(trace.setSpan(context.active(), span), fn)

      if (jobs.length === 1) {
        span.setAttribute(ATTR.messageId, jobs[0].id)
      } else {
        span.setAttribute(ATTR.batchMessageCount, jobs.length)
      }

      span.addLinks(this.#links(jobs, carrierOf))

      const instruments = this.#getInstruments()
      instruments?.operationDuration.record(seconds(startedAt), metricAttributes(attributes))
      if (jobs.length > 0) instruments?.consumedMessages.add(jobs.length, metricAttributes(attributes))

      return jobs
    } catch (err) {
      recordError(span, err)
      this.#getInstruments()?.operationDuration.record(seconds(startedAt), metricAttributes(attributes, err))
      throw err
    } finally {
      span.end()
    }
  }

  // Jobs a worker claimed. The worker's own fetch has no span: it polls on a timer, and a span per
  // empty poll would bury the traces that matter. The process span covers what it delivers.
  consumed (destination: string, count: number) {
    if (count === 0) return
    this.#getInstruments()?.consumedMessages.add(count, metricAttributes(baseAttributes('process', 'process', destination)))
  }

  /**
   * Runs a worker's handler over a batch in a CONSUMER `process` span. A batch of one continues the
   * trace its send() started; a larger batch starts a trace of its own and links to every send.
   *
   * `fn` resolves with the error the batch failed with, or undefined when it completed, because the
   * worker settles a failed batch itself rather than letting the error escape.
   */
  async process<J extends CarrierJob> (destination: string, jobs: J[], carrierOf: (job: J) => TraceCarrier | null | undefined, fn: () => Promise<unknown>): Promise<void> {
    if (!this.enabled) {
      await fn()
      return
    }

    const attributes = baseAttributes('process', 'process', destination)

    let parent: Context = ROOT_CONTEXT
    let links: Link[] = []
    if (jobs.length === 1) {
      attributes[ATTR.messageId] = jobs[0].id
      if (jobs[0].retryCount !== undefined) attributes[ATTR.retryCount] = jobs[0].retryCount
      // The whole extracted context, so baggage sent with the job reaches the handler too.
      const carrier = carrierOf(jobs[0])
      if (carrier) parent = propagation.extract(ROOT_CONTEXT, carrier)
    } else {
      attributes[ATTR.batchMessageCount] = jobs.length
      links = this.#links(jobs, carrierOf)
    }

    // The parent is chosen explicitly, never taken from context.active(): the worker loop inherits
    // whatever context work() was called in, and a job has nothing to do with that caller's trace.
    const span = this.#tracer.startSpan(
      spanName('process', destination),
      { kind: SpanKind.CONSUMER, attributes, links },
      parent
    )
    const startedAt = performance.now()

    let failure: unknown
    try {
      failure = await context.with(trace.setSpan(parent, span), fn)
    } catch (err) {
      failure = err ?? new Error('undefined error')
      throw err
    } finally {
      if (failure !== undefined) recordError(span, failure)
      this.#getInstruments()?.processDuration.record(seconds(startedAt), metricAttributes(attributes, failure))
      span.end()
    }
  }

  /**
   * Wraps a call that settles or removes jobs (complete, fail, cancel, deleteJob) in a CLIENT span.
   */
  async settle<T> (operation: string, destination: string, ids: string[], fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn()

    const attributes = baseAttributes(operation, 'settle', destination)
    if (ids.length === 1) {
      attributes[ATTR.messageId] = ids[0]
    } else {
      attributes[ATTR.batchMessageCount] = ids.length
    }

    const span = this.#tracer.startSpan(spanName(operation, destination), { kind: SpanKind.CLIENT, attributes })
    const startedAt = performance.now()

    try {
      const result = await context.with(trace.setSpan(context.active(), span), fn)
      this.#getInstruments()?.operationDuration.record(seconds(startedAt), metricAttributes(attributes))
      return result
    } catch (err) {
      recordError(span, err)
      this.#getInstruments()?.operationDuration.record(seconds(startedAt), metricAttributes(attributes, err))
      throw err
    } finally {
      span.end()
    }
  }

  #links<J> (jobs: J[], carrierOf: (job: J) => TraceCarrier | null | undefined): Link[] {
    const links: Link[] = []

    for (const job of jobs) {
      const spanContext = extractSpanContext(carrierOf(job))
      if (spanContext) links.push({ context: spanContext })
    }

    return links
  }
}

function extractSpanContext (carrier: TraceCarrier | null | undefined): SpanContext | null {
  if (!carrier) return null
  const spanContext = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, carrier))
  return spanContext && trace.isSpanContextValid(spanContext) ? spanContext : null
}

export default Telemetry
