# OpenTelemetry

pg-boss creates [OpenTelemetry](https://opentelemetry.io) spans and metrics following the [messaging semantic conventions](https://opentelemetry.io/docs/specs/semconv/messaging/). It uses `@opentelemetry/api`, declared as a peer dependency so that pg-boss shares your application's copy. npm and pnpm install it automatically; with Yarn, add it to your dependencies. Until one is registered, every span and instrument is a no-op.

```js
import { NodeSDK } from '@opentelemetry/sdk-node'
import { PgBoss } from 'pg-boss'

const sdk = new NodeSDK({ /* exporters, resource, ... */ })
sdk.start()

const boss = new PgBoss(connectionString)
await boss.start()
```

The trace context active when a job is sent is stored with the job, so the span that processes it continues the same trace, even when the job is processed hours later on another instance.

## Spans

| Span | Kind | Created by |
| --- | --- | --- |
| `send {queue}` | producer | `send()`, `sendAfter()`, `sendThrottled()`, `sendDebounced()` |
| `insert {queue}` | producer | `insert()` |
| `upsert {queue}` | producer | `upsert()`, whether it inserts a job or updates one |
| `flow {queue}` or `flow` | producer | `flow()`, named after the queue when every job in the flow shares one |
| `publish {event}` | producer | `publish()`, parent of the `send` span to each subscribed queue |
| `receive {queue}` | client | `fetch()` called by the application |
| `process {queue}` | consumer | a `work()` handler running over a batch |
| `complete {queue}`, `fail {queue}`, `cancel {queue}`, `delete {queue}` | client | `complete()`, `fail()`, `cancel()`, `deleteJob()` |

A `process` span covers the handler and the completion or failure pg-boss records after it, so spans created inside the handler, and spans of instrumented database calls, are its children.

When a worker processes one job at a time, the `process` span is a child of the job's `send` span, and baggage active at `send()` is active in the handler. A batch (`batchSize` above 1) starts a trace of its own and links to the `send` span of every job in it. `receive` spans link the same way. The trace context `work()` was called in is never used as a parent: the worker loop runs long after the call that started it.

A worker's own polling has no span, since a span per empty poll would bury the traces that matter. A handler that throws ends its `process` span with an error status, the exception recorded as an event, and `error.type` set.

The trace context survives retries, dead lettering and `redrive()`, so each attempt of a job, including its copy in a dead letter queue, is part of the trace its `send()` started.

### Attributes

| Attribute | Value |
| --- | --- |
| `messaging.system` | `pg-boss` |
| `messaging.operation.name` | `send`, `insert`, `flow`, `publish`, `receive`, `process`, `complete`, `fail`, `cancel` or `delete` |
| `messaging.operation.type` | `send`, `receive`, `process` or `settle` |
| `messaging.destination.name` | the queue name, or the event name for `publish` |
| `messaging.message.id` | the job id, when the operation involves exactly one job |
| `messaging.batch.message_count` | the number of jobs, when the operation involves any other number |
| `pgboss.job.retry_count` | on a `process` span for one job: the attempt, starting at 0 |
| `error.type` | the error's class name, when the operation failed |

## Metrics

| Metric | Type | Unit | Description |
| --- | --- | --- | --- |
| `messaging.client.sent.messages` | counter | `{message}` | Jobs `send()`, `insert()`, `flow()` and `publish()` attempted to create, and jobs `upsert()` inserted |
| `messaging.client.consumed.messages` | counter | `{message}` | Jobs delivered to a worker or returned by `fetch()` |
| `messaging.client.operation.duration` | histogram | `s` | Duration of each send, receive and settle operation |
| `messaging.process.duration` | histogram | `s` | Duration of each `process` span |
| `pgboss.queue.jobs` | gauge | `{job}` | Jobs per queue by `pgboss.job.state` (`deferred`, `ready`, `active`, `failed`), as of the last queue cache refresh |

Metrics carry `messaging.system`, `messaging.operation.name`, `messaging.operation.type`, `messaging.destination.name` and, on failure, `error.type`. Job ids and batch sizes are left out so they don't multiply the number of series.

`pgboss.queue.jobs` reads the counts pg-boss already keeps in memory, refreshed every [`queueCacheIntervalSeconds`](./api/constructor.md#queuecacheintervalseconds) from the stats [monitoring](./api/constructor.md#monitorintervalseconds) records, so observing it runs no queries.

## Options

Pass `openTelemetry` to the [constructor](./api/constructor.md#opentelemetry).

```js
const boss = new PgBoss({
  connectionString,
  openTelemetry: {
    enabled: true,
    propagateContext: true,
    tracerProvider, // defaults to the global tracer provider
    meterProvider   // defaults to the global meter provider
  }
})
```

* **enabled**, bool, default true

  Set to false to create no spans or metrics and store no trace context.

* **propagateContext**, bool, default true

  Store the trace context of `send()` on the job, using the propagator registered globally with the OpenTelemetry API. An SDK registers W3C Trace Context and Baggage when it starts, unless the application configures another. With no propagator registered, as when only a `tracerProvider` is passed without registering it globally, nothing is stored. With `propagateContext: false`, each `process` span starts a trace of its own.

* **tracerProvider**, `TracerProvider`

  The provider to create spans with instead of the global one.

* **meterProvider**, `MeterProvider`

  The provider to create instruments with instead of the global one.

## Database instrumentation

pg-boss talks to Postgres through `pg`, so `@opentelemetry/instrumentation-pg` records a span for each of its queries, including a worker's polling. Queries made inside a `process` span nest under it. To drop the polling queries, which run outside any span, set the instrumentation's `requireParentSpan` option:

```js
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'

new NodeSDK({
  instrumentations: [new PgInstrumentation({ requireParentSpan: true })]
})
```

## Storage

The trace context is stored in the `trace_context` column of the job table, as the propagator's key/value pairs (for example `{"traceparent": "00-..."}`). It is written when the job is created and copied onto its retries, its dead letter copy and a redriven job. An `upsert()` that updates an existing job leaves its trace context unchanged. It is not part of the job object passed to handlers or returned by `fetch()` and `getJobById()`.
