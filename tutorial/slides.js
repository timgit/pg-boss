/* The curriculum. Every `kind: 'code'` panel that names a `file` is copied VERBATIM from
   that file — tutorial/verify-excerpts.mjs re-checks each one against the source and
   reports the real line numbers, so run it after touching anything here.
   Panels with `label` instead of `file` are illustrative and are not checked. */
(function (global) {
  const PGB = global.PGB = global.PGB || {}

  PGB.SLIDES = [

    /* ================= Ch 0 · Orientation ================= */

    {
      id: 'core-bet',
      chapter: 'Orientation',
      title: 'The core bet',
      body: `
<p class="lede">pg-boss is a job queue with no broker in it. The queue is a Postgres table, and
the delivery guarantee is Postgres' own lock manager.</p>

<p>Every other design decision in this codebase follows from that one bet. Producing a job is an
<code>INSERT</code>. Claiming a job is a <code>SELECT … FOR UPDATE SKIP LOCKED</code> wrapped in an
<code>UPDATE</code>. Completing one is an <code>UPDATE</code>. There is no in-memory state that
matters, no leader election, and no separate service to run.</p>

<h2>What the bet buys you</h2>
<ul>
  <li><strong>Exactly-once delivery</strong> without a distributed protocol — two workers running
  the identical query cannot claim the same row, because the second one's scan steps over the
  lock the first one holds.</li>
  <li><strong>Transactional enqueue.</strong> You can create a job inside the same transaction
  that writes your business data. Either both land or neither does.</li>
  <li><strong>One system to operate.</strong> Your backups, your monitoring, your failover story
  already cover the queue.</li>
</ul>

<h2>What it costs</h2>
<ul>
  <li>Throughput is bounded by your database, and every worker poll is a query.</li>
  <li>A busy queue is table churn, so <strong>retention and deletion are first-class
  concerns</strong> — a whole background subsystem exists to keep the table from growing without
  bound.</li>
  <li><code>SKIP LOCKED</code> is not universal. Supporting CockroachDB and friends means a
  second fetch strategy, which is why compatibility flags thread through half the codebase.</li>
</ul>

<div class="callout"><p>Keep the bet in mind as you read. When a piece of this codebase looks
unusual — deleting a row and re-inserting it instead of updating it, enforcing invariants with
partial unique indexes, moving work off the completion path — it is almost always because the
database is doing a job that application code would do in a broker-based queue.</p></div>
`,
      panels: [
        { kind: 'svg', name: 'core-bet' },
        {
          kind: 'code',
          lang: 'ts',
          label: 'the whole library, roughly',
          text: `import PgBoss from 'pg-boss'

const boss = new PgBoss('postgres://…')
await boss.start()

await boss.createQueue('email')
await boss.work('email', async ([job]) => send(job.data))
await boss.send('email', { to: 'you@example.com' })`,
          note: 'Four public calls. Nearly everything in <code>src/</code> exists to make these safe under concurrency, failure, and time.'
        }
      ]
    },

    {
      id: 'repo-map',
      chapter: 'Orientation',
      title: 'The map of src/',
      body: `
<p>Twenty-two files, about 11,800 lines. The mass is wildly uneven, and that unevenness is the
first useful thing to learn: four files are two thirds of the code, and almost none of the
interesting <em>design</em> is in them.</p>

<h2>The big four (mostly data)</h2>
<table>
  <tr><th>File</th><th>Lines</th><th>What it is</th></tr>
  <tr><td><code>plans.ts</code></td><td>3029</td><td>Every SQL string in the library</td></tr>
  <tr><td><code>manager.ts</code></td><td>2036</td><td>All job and queue operations</td></tr>
  <tr><td><code>migrationStore.ts</code></td><td>1288</td><td>The versioned migration chain</td></tr>
  <tr><td><code>types.ts</code></td><td>1133</td><td>Public and internal types</td></tr>
</table>

<h2>The small files (mostly design)</h2>
<table>
  <tr><td><code>notifier.ts</code></td><td>96</td><td>LISTEN/NOTIFY lifecycle</td></tr>
  <tr><td><code>worker.ts</code></td><td>166</td><td>One polling loop</td></tr>
  <tr><td><code>navigator.ts</code></td><td>173</td><td>Flow dependency resolver</td></tr>
  <tr><td><code>bam.ts</code></td><td>175</td><td>Async migration worker</td></tr>
  <tr><td><code>db.ts</code></td><td>241</td><td>Default <code>IDatabase</code> over a pg pool</td></tr>
  <tr><td><code>contractor.ts</code></td><td>249</td><td>Install / migrate on start</td></tr>
  <tr><td><code>timekeeper.ts</code></td><td>256</td><td>Cron scheduling</td></tr>
  <tr><td><code>boss.ts</code></td><td>292</td><td>The background supervisor</td></tr>
</table>

<p>Then the supporting cast: <code>index.ts</code> (614, the public facade), <code>attorney.ts</code>
(747, validation), <code>drifter.ts</code> (503, schema diffing), <code>cli.ts</code> (603),
<code>adapters/</code>, plus <code>spy.ts</code>, <code>tools.ts</code> and <code>warning.ts</code>.</p>

<div class="callout"><p><strong>This repo is a fork.</strong> It is Bun-first: the whole test suite
runs under Bun and cannot run under Node. Two root files carry live context you should read before
touching related code — <code>ISSUES.txt</code> (known Bun-adapter problems) and
<code>REPORT.md</code> (a feasibility analysis for a SQLite backend, describing work not done).</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'plain',
          label: 'src/',
          text: `src/
├── index.ts            the public PgBoss class — composes and delegates
├── attorney.ts         validation + backend profile → compatibility flags
├── plans.ts            ALL SQL lives here
├── types.ts            public + internal types (IDatabase lives here)
│
├── manager.ts          jobs, queues, workers, pub/sub
├── worker.ts           one polling loop, injected with closures
├── db.ts               default IDatabase over pg.Pool, incl. listen()
├── notifier.ts         LISTEN/NOTIFY lifecycle
│
├── boss.ts             supervisor: monitor + maintain
├── timekeeper.ts       cron
├── navigator.ts        flow / dependency resolver
├── bam.ts              background async migrations (slow DDL)
│
├── contractor.ts       install + migrate on start()
├── migrationStore.ts   the versioned migration chain
├── drifter.ts          generic schema diff engine
├── schema.json         GENERATED manifest — never hand-edit
│
├── cli.ts              the pg-boss binary
├── spy.ts              test helper: waitForJob
├── tools.ts            delay(), schema name resolution
├── warning.ts          shared warning emit + persist
└── adapters/
    ├── pglite.ts       PGlite → IDatabase
    └── bun.ts          Bun SQL → IDatabase (+ workarounds)`,
          note: 'Read in this order and each file motivates the next.'
        }
      ]
    },

    {
      id: 'dev-workflow',
      chapter: 'Orientation',
      title: 'Getting a working loop',
      body: `
<p>Before reading further, get the suite green once. Everything in this tutorial is checkable
against a running database, and the fastest way to understand a query is to break it and watch
which test fails.</p>

<h2>The loop</h2>
<ol>
  <li><code>docker compose up -d db</code> — starts a Postgres matching
  <code>test/config.json</code> (database <code>pgboss</code>, user and password
  <code>postgres</code>).</li>
  <li><code>bun run test</code> — the full check.</li>
  <li><code>bun run test -- test/sendTest.ts</code> — one file.</li>
  <li><code>bun run test -- -t "substring"</code> — tests matching a name.</li>
</ol>

<div class="callout warn"><p><strong>Bun is required, and not just as a runner.</strong>
<code>test/testHelper.ts</code> imports Bun's <code>SQL</code> client at module load, so the suite
cannot run under Node at all. The published library still targets Node ≥ 22.12 and
PostgreSQL ≥ 13 — that split is deliberate.</p></div>

<h2>The pretest hook will bite you</h2>
<p><code>pretest</code> runs <code>tsc --noEmit</code> and <code>gen:manifest:check</code>
<em>before</em> a single test executes. So a type error, or a DDL change in
<code>plans.ts</code> that you forgot to regenerate <code>schema.json</code> for, fails
<code>bun run test</code> with an error that has nothing to do with any test. When
<code>bun run test</code> fails instantly, read the first few lines carefully — the answer is
usually "run <code>bun run gen:manifest</code>".</p>

<h2>The backend matrix</h2>
<p>The same suite runs against several engines, selected by environment variables that
<code>test/testHelper.ts</code> resolves:</p>
<ul>
  <li><code>test:distributed</code> — <code>DISTRIBUTED=true</code>. Runs the atomic-UPDATE fetch
  path on plain Postgres. Fast, no extra database, and the one you should run most often.</li>
  <li><code>test:bun</code> — routes every query through the <code>fromBunSql</code> adapter.</li>
  <li><code>test:pglite</code> — in-process WASM Postgres, no server at all.</li>
  <li><code>test:cockroachdb</code> / <code>yugabytedb</code> / <code>citus</code> — real
  distributed engines, each with its own compose file.</li>
</ul>
`,
      panels: [
        {
          kind: 'code',
          lang: 'json',
          file: 'package.json',
          lines: '39-47',
          text: `    "pretest": "bun run tsc && bun run gen:manifest:check",
    "test": "eslint . && bun --bun vitest run",
    "test:distributed": "DISTRIBUTED=true bun run test",
    "test:cockroachdb": "DB_TYPE=cockroachdb COCKROACH_HOST=localhost bun run test -- test/distributedDatabaseTest.ts",
    "test:cockroachdb:full": "DB_TYPE=cockroachdb COCKROACH_HOST=localhost bun run test -- --no-file-parallelism",
    "test:yugabytedb:full": "DB_TYPE=yugabytedb YUGABYTE_HOST=localhost bun run test -- --no-file-parallelism",
    "test:citus:full": "DB_TYPE=citus CITUS_HOST=localhost bun run test",
    "test:pglite": "DB_TYPE=pglite bun run test",
    "test:bun": "DB_TYPE=bun bun run test",`,
          note: 'Note that <code>test</code> begins with <code>eslint .</code> — lint failures block the suite too.'
        }
      ]
    },

    /* ================= Ch 1 · Composition and lifecycle ================= */

    {
      id: 'facade',
      chapter: 'Composition & lifecycle',
      title: 'PgBoss is a facade',
      body: `
<p>The public class does almost nothing. Its constructor is a composition root: it resolves the
config, gets a database handle, and builds seven collaborators that all share those two things.
Every public method after that is a one-line delegation.</p>

<p>Read the constructor as a dependency graph. <code>Contractor</code> only needs the database and
config. <code>Boss</code>, <code>Timekeeper</code>, <code>Navigator</code> and <code>Notifier</code>
each also take the <code>Manager</code>, because their job is ultimately to cause job operations.
Two of them are wired back the other way — <code>manager.timekeeper</code> and
<code>manager.notifier</code> — so the manager can schedule and wake without importing them.</p>

<h2>Why this shape matters to you</h2>
<ul>
  <li>There is <strong>one</strong> <code>IDatabase</code> and <strong>one</strong> resolved config
  in the whole instance. If you need new behaviour to be configurable, it goes through
  <code>attorney.getConfig</code> and is then visible everywhere.</li>
  <li>Nothing in the constructor touches the database. Construction is cheap and cannot fail on
  connectivity; that is <code>start()</code>'s job.</li>
  <li>When you add a subsystem, you add it here, promote its events, and gate its startup on a
  config flag. That is the entire pattern.</li>
</ul>
`,
      panels: [
        { kind: 'svg', name: 'composition' },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/index.ts',
          lines: '58-103',
          text: `  constructor (value: string | types.ConstructorOptions) {
    super()
    this.#stoppingOn = null
    this.#stopped = true

    const config = Attorney.getConfig(value)
    this.#config = config

    const db: (types.IDatabase & { _pgbdb?: false }) | DbDefault = this.getDb()
    this.#db = db

    if ('_pgbdb' in this.#db && this.#db._pgbdb) {
      this.#promoteEvents(this.#db)
    }

    const contractor = new Contractor(db, config)

    const manager = new Manager(db, config)

    const boss = new Boss(db, manager, config)

    const timekeeper = new Timekeeper(db, manager, config)
    manager.timekeeper = timekeeper

    const bam = new Bam(db, config)

    const navigator = new Navigator(db, manager, config)

    const notifier = new Notifier(db, manager, config)
    manager.notifier = notifier

    this.#promoteEvents(manager)
    this.#promoteEvents(boss)
    this.#promoteEvents(timekeeper)
    this.#promoteEvents(bam)
    this.#promoteEvents(navigator)
    this.#promoteEvents(notifier)

    this.#boss = boss
    this.#contractor = contractor
    this.#manager = manager
    this.#timekeeper = timekeeper
    this.#bam = bam
    this.#navigator = navigator
    this.#notifier = notifier
  }`
        }
      ]
    },

    {
      id: 'event-promotion',
      chapter: 'Composition & lifecycle',
      title: 'Event promotion in four lines',
      body: `
<p>Each collaborator is its own <code>EventEmitter</code> and declares an <code>events</code> map
naming the events it emits. <code>#promoteEvents</code> walks that map and re-emits every one of
them on the <code>PgBoss</code> instance. That is the complete mechanism by which
<code>error</code>, <code>warning</code>, <code>wip</code>, <code>stopped</code>,
<code>bam</code> and <code>flow</code> reach your code.</p>

<p>The convention is worth internalising because it is load-bearing in both directions:</p>

<ul>
  <li>A subsystem <strong>never</strong> holds a reference to the <code>PgBoss</code> instance. It
  emits locally; promotion is the parent's concern. That is why <code>notifier.ts</code> and
  friends are independently testable.</li>
  <li>If you add an event to a subsystem, you add it to that subsystem's <code>events</code>
  object and it surfaces automatically. Forget to, and it silently never reaches users — there is
  no error, just an event nobody hears.</li>
</ul>

<div class="callout"><p>The <code>error</code> event matters more here than in most libraries. A
background poller that throws has nowhere else to report; several subsystems catch broadly and
<code>emit('error', err)</code> rather than crash the process. An application that does not
listen for <code>error</code> is throwing that information away.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/index.ts',
          lines: '105-109',
          text: `  #promoteEvents (emitter: types.EventsMixin) {
    for (const event of Object.values(emitter?.events) as (keyof types.PgBossEventMap)[]) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/index.ts',
          lines: '19-26',
          text: `export const events: types.Events = Object.freeze({
  error: 'error',
  warning: 'warning',
  wip: 'wip',
  stopped: 'stopped',
  bam: 'bam',
  flow: 'flow'
})`,
          note: 'The full public event surface. Each name is also a key in some subsystem&#39;s own <code>events</code> map.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/notifier.ts',
          lines: '6-9',
          text: `const events = {
  error: 'error',
  warning: 'warning'
}`,
          note: 'A subsystem declares only what it emits. <code>Notifier</code> emits two events and knows nothing about the rest.'
        }
      ]
    },

    {
      id: 'lifecycle',
      chapter: 'Composition & lifecycle',
      title: 'start() and stop() are harder than they look',
      body: `
<p><code>start()</code> is idempotent, re-entrant, and interleaves correctly with
<code>stop()</code>. Three separate mechanisms make that true, and each one has a comment in the
source explaining the failure it prevents.</p>

<ol>
  <li><strong>Await an in-flight <code>stop()</code> first.</strong> Otherwise the two race over
  the same intervals and pool.</li>
  <li><strong>Return the <em>same</em> promise to a concurrent caller</strong> rather than a fresh
  <code>this</code>. A second caller must observe the real outcome, including a rejection — not
  silently no-op while the first call is still mid-flight.</li>
  <li><strong>Clear <code>#stopped</code> before starting anything</strong>, not after success. If
  <code>#doStart</code> throws halfway, the subsystems that <em>did</em> start still need to be
  reachable by <code>stop()</code>, and <code>stop()</code> no-ops whenever <code>#stopped</code>
  is true.</li>
</ol>

<h2>Startup order is a contract</h2>
<p><code>#doStart</code> reads as a checklist: open the pool, warn about a misconfigured backend,
install-or-migrate the schema, then start the manager, and only then the optional subsystems, each
gated on its own config flag. <code>Contractor</code> must go first — every other subsystem
assumes the schema exists at the current version.</p>

<p><code>#doStop</code> is the mirror image: stop the notifier first (so no new wakeups arrive),
then the manager, then the background pollers, then drain. The graceful path loops on
<code>manager.hasPendingCleanups()</code> until the timeout before it closes the pool.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/index.ts',
          lines: '111-141',
          text: `  async start (): Promise<this> {
    // A stop() already in flight must finish (clearing any resources it's tearing down) before a
    // fresh start() begins, otherwise the two race over the same intervals/pool.
    if (this.#stoppingPromise) {
      await this.#stoppingPromise.catch(() => {})
    }

    // Return the SAME in-flight promise to a concurrent caller instead of a fresh \`this\` — a
    // second caller must observe the actual outcome (including a rejection), not silently no-op
    // while the first call is still mid-flight.
    if (this.#startingPromise) {
      return this.#startingPromise
    }

    if (this.#started) {
      return this
    }

    // Cleared to false before any subsystem is started (not just on success): if #doStart throws
    // partway through, subsystems already started (e.g. manager's queueCacheInterval/wipInterval)
    // must still be reachable by stop() for cleanup, and stop() no-ops whenever #stopped is true.
    this.#stopped = false

    this.#startingPromise = this.#doStart()

    try {
      return await this.#startingPromise
    } finally {
      this.#startingPromise = null
    }
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/index.ts',
          lines: '150-173',
          text: `    if (this.#config.migrate) {
      await this.#contractor.start()
    } else {
      await this.#contractor.check()
    }

    await this.#manager.start()

    if (this.#config.useListenNotify) {
      await this.#notifier.start()
    }

    if (this.#config.supervise) {
      await this.#boss.start()
      await this.#navigator.start()
    }

    if (this.#config.schedule) {
      await this.#timekeeper.start()
    }

    if (this.#config.migrate) {
      await this.#bam.start()
    }`,
          note: 'Every optional subsystem is gated on a flag. <code>supervise: false</code> disables both the supervisor and the flow resolver — which is exactly what the test suite does.'
        }
      ]
    },

    {
      id: 'attorney',
      chapter: 'Composition & lifecycle',
      title: 'attorney.ts: validation lives here, nowhere deeper',
      body: `
<p>There is one validation layer and this is it. <code>getConfig</code> normalises constructor
options; the <code>check*</code> functions validate <code>send</code> / <code>work</code> /
<code>fetch</code> / <code>schedule</code> arguments before they reach <code>manager.ts</code>.
No <code>assert</code> belongs deeper in the stack.</p>

<h2>Backend support is data, not branches</h2>
<p>The most interesting thing in the file is that multi-database support is expressed as a table.
Eight boolean compatibility flags, five backend profiles, and a profile only lists the flags where
it differs from stock Postgres. <code>resolveBackend</code> then expands the profile with
<code>config[flag] = flags[flag] ?? false</code>, so <strong>every flag is always defined</strong>
and no deployment can end up in an inconsistent combination.</p>

<p>These flags are not part of the public input. A user picks <code>backend: 'cockroachdb'</code>;
they cannot pick <code>noSkipLocked</code>. The <code>__test__*</code> hooks at the bottom of
<code>resolveBackend</code> are the exception, and they are how <code>DISTRIBUTED=true</code> runs
the distributed code paths against plain Postgres.</p>

<div class="callout"><p>Note the ordering in <code>getConfig</code>: <code>resolveBackend</code>
runs <em>before</em> the <code>apply*</code> steps, because later validation can depend on which
flags are set.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/attorney.ts',
          lines: '11-23',
          text: `// The internal compatibility flags a backend can toggle. A backend sets only the flags that differ
// from stock PostgreSQL; everything else defaults to false. These are derived from the backend
// profile and are not user-configurable (see resolveBackend).
const COMPATIBILITY_FLAGS = [
  'noSkipLocked',
  'noMultiMutationCte',
  'noTablePartitioning',
  'noDeferrableConstraints',
  'noAdvisoryLocks',
  'noCoveringIndexes',
  'noListenNotify',
  'noIndexProgressView'
] as const`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/attorney.ts',
          lines: '38-54',
          text: `const BACKEND_PROFILES: Record<types.BackendProfile, BackendDefinition> = {
  postgres: { kind: 'standard', flags: {} },
  cockroachdb: {
    kind: 'distributed',
    flags: {
      noSkipLocked: true,
      noMultiMutationCte: true,
      noTablePartitioning: true,
      noDeferrableConstraints: true,
      noAdvisoryLocks: true,
      noCoveringIndexes: true,
      noListenNotify: true,
      // Online DDL runs as a schema-change job, not the PG CONCURRENTLY path, and
      // pg_stat_progress_create_index isn't available — so BAM can't use liveness-based reclaim.
      noIndexProgressView: true
    }
  },`,
          note: 'CockroachDB sets seven of the eight. PGlite sets none — it is real Postgres, just embedded.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/attorney.ts',
          lines: '482-500',
          text: `function resolveBackend (config: any) {
  const backend = ('backend' in config) ? config.backend : 'postgres'

  assert(backend in BACKEND_PROFILES,
    \`configuration assert: backend must be one of \${Object.keys(BACKEND_PROFILES).join(', ')}\`)

  config.backend = backend
  const { flags } = BACKEND_PROFILES[backend as types.BackendProfile]

  for (const flag of COMPATIBILITY_FLAGS) {
    config[flag] = flags[flag] ?? false
  }

  // Test hook: exercise the distributed runtime paths (atomic fetch + split mutations)
  // on top of the current backend's schema, without standing up a distributed database.
  if (config.__test__distributed) {
    config.noSkipLocked = true
    config.noMultiMutationCte = true
  }`
        }
      ],
      quiz: {
        q: 'You add a new query that uses two <code>UPDATE</code> statements inside one CTE. Which compatibility flag decides whether it needs an alternative implementation?',
        options: [
          '<code>noSkipLocked</code> — locking is what differs between engines',
          '<code>noMultiMutationCte</code> — some engines allow only one mutation per statement',
          '<code>noTablePartitioning</code> — CTEs and partitions interact badly',
          'None. Compatibility flags only affect DDL, never runtime queries.'
        ],
        answer: 1,
        explain: '<code>noMultiMutationCte</code>. CockroachDB permits a single mutation per statement, so every multi-mutation CTE in <code>plans.ts</code> has a split twin that the manager runs inside a transaction instead. Whenever you write a query with more than one writing CTE, that is the flag to check.'
      }
    },

    /* ================= Ch 2 · The data model ================= */

    {
      id: 'plans-source-of-truth',
      chapter: 'The data model',
      title: 'plans.ts is the single source of truth',
      body: `
<p>There is exactly one rule about SQL in this codebase, and it has no exceptions:
<strong>every SQL string lives in <code>src/plans.ts</code></strong> (migration deltas live in
<code>migrationStore.ts</code>). Components never inline SQL. They call a <code>plans.*</code>
builder and hand the result to <code>db.executeSql</code>.</p>

<p>Builders are plain functions — no query-builder library — with the shape
<code>(schema, …) =&gt; string</code>, or <code>=&gt; { text, values }</code> when parameters are
involved. The schema name is interpolated because it is an <em>identifier</em>, which cannot be a
bind parameter. Values are always bound.</p>

<h2>Finding your way around 3,000 lines</h2>
<table>
  <tr><th>Lines</th><th>Zone</th></tr>
  <tr><td>13–83</td><td>Constants: <code>JOB_STATES</code>, <code>QUEUE_POLICIES</code>, <code>QUEUE_DEFAULTS</code></td></tr>
  <tr><td>85–130</td><td><code>create()</code> — the whole install script</td></tr>
  <tr><td>132–485</td><td>DDL builders, one per table plus the plpgsql helpers</td></tr>
  <tr><td>487–755</td><td><code>create_queue</code> / <code>delete_queue</code> and the nine job indexes</td></tr>
  <tr><td>1244–1518</td><td>Fetch</td></tr>
  <tr><td>1520–1665</td><td>complete / cancel / resume / restore</td></tr>
  <tr><td>1666–1795</td><td>insert</td></tr>
  <tr><td>1797–2130</td><td>fail / retry / touch / dead-letter</td></tr>
  <tr><td>2131–2330</td><td>flow resolution, redrive, deletion</td></tr>
  <tr><td>2675–3029</td><td>BAM, then the drift probes</td></tr>
</table>

<p><code>create()</code> is a good first read: it is the entire schema as one ordered array of
commands, wrapped in <code>locked()</code> so two instances installing simultaneously serialise on
an advisory lock. Notice how the <code>noPartitioning</code> flag from the previous chapter selects
between whole branches of the install.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '85-130',
          text: `export function create (schema: string, version: number, options?: CreateOptions) {
  const noPartitioning = options?.noTablePartitioning ?? false
  const noDeferrable = options?.noDeferrableConstraints ?? false
  const noLocks = options?.noAdvisoryLocks ?? false
  const noCovering = options?.noCoveringIndexes ?? false

  const commands = [
    options?.createSchema ? createSchema(schema) : '',
    createEnumJobState(schema),

    createTableVersion(schema),
    createTableQueue(schema),
    createTableSchedule(schema),
    createTableSubscription(schema),
    createTableBam(schema),

    // Partition-helper functions are only used by the partitioned architecture.
    // They are unused when partitioning is disabled, and job_table_format's
    // IMMUTABLE + format() body is rejected at create time by databases like
    // CockroachDB, so skip them entirely in noTablePartitioning mode.
    noPartitioning ? '' : jobTableFormatFunction(schema),
    noPartitioning ? '' : jobTableRunFunction(schema),
    noPartitioning ? '' : jobTableRunAsyncFunction(schema),

    createTableJob(schema, noPartitioning),
    createPrimaryKeyJob(schema),
    noPartitioning ? createTableJobIndexes(schema, noDeferrable, noCovering) : createTableJobCommon(schema),

    createTableWarning(schema),
    createIndexWarning(schema),

    createTableQueueStats(schema, noPartitioning),
    createIndexQueueStats(schema, noCovering),
    noPartitioning ? '' : ensureQueueStatsPartitions(schema),

    createTableJobDependency(schema),
    createIndexJobDependencyParent(schema),

    createQueueFunction(schema, noPartitioning),
    deleteQueueFunction(schema, noPartitioning),

    insertVersion(schema, version)
  ]

  return locked(schema, commands, undefined, noLocks)
}`,
          note: 'The complete list of objects pg-boss owns. If it is not in this array, pg-boss did not create it.'
        }
      ]
    },

    {
      id: 'job-state-enum',
      chapter: 'The data model',
      title: 'The job_state enum, and why its order is semantic',
      body: `
<p>Six states, defined once, in SQL. There is no state-machine class anywhere in the TypeScript —
transitions are <code>UPDATE</code> statements, and the states themselves are a Postgres
<code>ENUM</code>.</p>

<p>The two-line comment above the <code>CREATE TYPE</code> is the most consequential comment in the
repository:</p>

<div class="callout"><p><strong>ENUM definition order is important — the base type is numeric and
first values are less than last values.</strong></p></div>

<p>That makes the declaration order a total ordering:</p>

<p><code>created</code> (0) &lt; <code>retry</code> (1) &lt; <code>active</code> (2) &lt;
<code>completed</code> (3) &lt; <code>cancelled</code> (4) &lt; <code>failed</code> (5)</p>

<p>And that ordering is used <em>everywhere</em> in place of set membership:</p>

<ul>
  <li><code>state &lt; 'active'</code> means "fetchable" — created or retry, in one comparison.</li>
  <li><code>state &lt;= 'active'</code> means "not yet finished".</li>
  <li><code>state &lt; 'completed'</code> means "still cancellable".</li>
</ul>

<div class="callout warn"><p>If you ever add a state, where you put it in the enum changes the
meaning of every one of those predicates. This is not a list you can safely append to.</p></div>

<p>The TypeScript mirror at <code>plans.ts:46</code> exists so the builders can interpolate the
names, and it is re-exported publicly as <code>states</code>. Almost nothing else in
<code>src/</code> references it: the states matter inside SQL, not around it.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '136-149',
          text: `function createEnumJobState (schema: string) {
  // ENUM definition order is important
  // base type is numeric and first values are less than last values
  return \`
    CREATE TYPE \${schema}.job_state AS ENUM (
      '\${JOB_STATES.created}',
      '\${JOB_STATES.retry}',
      '\${JOB_STATES.active}',
      '\${JOB_STATES.completed}',
      '\${JOB_STATES.cancelled}',
      '\${JOB_STATES.failed}'
    )
  \`
}`
        },
        { kind: 'svg', name: 'job-states', caption: 'Each edge is owned by a builder in <code>plans.ts</code>, not by a class.' }
      ]
    },

    {
      id: 'job-table',
      chapter: 'The data model',
      title: 'The job table',
      body: `
<p>One table holds every job, and its columns are worth knowing by heart because almost every query
in the codebase touches some subset of them.</p>

<h2>Identity and routing</h2>
<p><code>id</code>, <code>name</code> (the queue), <code>data</code>, <code>priority</code>,
<code>state</code>. The primary key is <strong><code>(name, id)</code></strong>, not
<code>id</code> — a partitioned table must include the partition key in every unique constraint,
and <code>name</code> is the partition key. That is why every job API takes the queue name
alongside the id.</p>

<h2>Retry policy, copied per job</h2>
<p><code>retry_limit</code>, <code>retry_count</code>, <code>retry_delay</code>,
<code>retry_backoff</code>, <code>retry_delay_max</code>. These are <em>denormalised onto the
row</em> from the queue at insert time, so changing a queue's defaults does not retroactively
change in-flight jobs, and the fail path never needs to join.</p>

<h2>Time</h2>
<p><code>start_after</code> (eligibility), <code>created_on</code>, <code>started_on</code>,
<code>completed_on</code>, <code>keep_until</code> (retention), <code>expire_seconds</code>
(how long an active job may run), <code>deletion_seconds</code>, plus <code>heartbeat_on</code> /
<code>heartbeat_seconds</code> for liveness.</p>

<h2>Policy and deduplication</h2>
<p><code>policy</code> and <code>singleton_key</code> / <code>singleton_on</code> — the columns the
partial unique indexes key on. <code>group_id</code> / <code>group_tier</code> drive group
concurrency.</p>

<h2>Flow and dead-lettering</h2>
<p><code>blocked</code>, <code>blocking</code>, <code>pending_dependencies</code> for job
dependencies; <code>dead_letter</code> plus the four <code>source_*</code> columns, which record
where a dead-lettered job came from.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '376-415',
          text: `function createTableJob (schema: string, noPartitioning = false) {
  const partitionClause = noPartitioning ? '' : 'PARTITION BY LIST (name)'
  return \`
    CREATE TABLE \${schema}.job (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state \${schema}.job_state not null default '\${JOB_STATES.created}',
      retry_limit integer not null default \${QUEUE_DEFAULTS.retry_limit},
      retry_count integer not null default 0,
      retry_delay integer not null default \${QUEUE_DEFAULTS.retry_delay},
      retry_backoff boolean not null default \${QUEUE_DEFAULTS.retry_backoff},
      retry_delay_max integer,
      expire_seconds int not null default \${QUEUE_DEFAULTS.expire_seconds},
      deletion_seconds int not null default \${QUEUE_DEFAULTS.deletion_seconds},
      singleton_key text,
      singleton_on timestamp without time zone,
      group_id text,
      group_tier text,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '\${QUEUE_DEFAULTS.retention_seconds}',
      output jsonb,
      dead_letter text,
      policy text,
      heartbeat_on timestamp with time zone,
      heartbeat_seconds int,
      blocked boolean not null default false,
      blocking boolean not null default false,
      pending_dependencies int not null default 0,
      source_name text,
      source_id uuid,
      source_created_on timestamp with time zone,
      source_retry_count int
    ) \${partitionClause}
  \`
}`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '693-695',
          text: `function createPrimaryKeyJob (schema: string) {
  return \`ALTER TABLE \${schema}.job ADD PRIMARY KEY (name, id)\`
}`,
          note: 'Added separately from the CREATE TABLE, because it also has to be applied to every partition.'
        }
      ]
    },

    {
      id: 'queue-table',
      chapter: 'The data model',
      title: 'The queue table is config and cache at once',
      body: `
<p>The <code>queue</code> table does two unrelated jobs, and separating them in your head makes the
rest of the codebase much easier to read.</p>

<h2>1. It is the defaults a job inherits</h2>
<p><code>policy</code>, <code>retry_*</code>, <code>expire_seconds</code>,
<code>retention_seconds</code>, <code>deletion_seconds</code>, <code>dead_letter</code>,
<code>heartbeat_seconds</code>. When a job is inserted, each of these is
<code>COALESCE</code>d with the per-job option — you will see that cascade in the next chapter.</p>

<h2>2. It is a denormalised stats cache</h2>
<p><code>queued_count</code>, <code>ready_count</code>, <code>active_count</code>,
<code>failed_count</code>, <code>total_count</code>, <code>ready_history</code>,
<code>singletons_active</code>, plus <code>monitor_on</code> and <code>maintain_on</code>. Nothing
reads these to decide correctness. They exist so a worker can ask "is there a backlog?" without
counting rows in a table that may hold millions, and so the supervisor can rate-limit itself.</p>

<h2>And one column that routes everything</h2>
<p><code>table_name</code> is the physical table this queue's jobs live in. Every job query needs
it, so the manager keeps a read-through cache: <code>getQueueCache(name)</code> returns the row,
populating on miss and throwing a clear error for an unknown queue. That single method is the first
step in roughly twenty manager methods and it is what makes partitioning invisible to the rest of
the code.</p>

<div class="callout"><p><code>dead_letter</code> is a self-referencing foreign key with
<code>CHECK (dead_letter IS DISTINCT FROM name)</code> — a queue cannot be its own dead-letter
queue, and the target must exist.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '162-195',
          text: `function createTableQueue (schema: string) {
  return \`
    CREATE TABLE \${schema}.queue (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES \${schema}.queue (name) CHECK (dead_letter IS DISTINCT FROM name),
      partition bool NOT NULL,
      table_name text NOT NULL,
      deferred_count int NOT NULL default 0,
      queued_count int NOT NULL default 0,
      ready_count int NOT NULL default 0,
      warning_queued int NOT NULL default 0,
      active_count int NOT NULL default 0,
      failed_count int NOT NULL default 0,
      total_count int NOT NULL default 0,
      ready_history int[] NOT NULL default '{}',
      heartbeat_seconds int,
      notify bool NOT NULL DEFAULT false,
      singletons_active text[],
      monitor_on timestamp with time zone,
      maintain_on timestamp with time zone,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name)
    )
  \`
}`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/manager.ts',
          lines: '552-570',
          text: `  async getQueueCache (name: string): Promise<types.QueueResult> {
    assert(this.queues, 'Queue cache is not initialized')

    let queue = this.queues[name]

    if (queue) {
      return queue
    }

    queue = await this.getQueue(name)

    if (!queue) {
      throw new Error(\`Queue \${name} does not exist\`)
    }

    this.queues[name] = queue

    return queue
  }`,
          note: 'The cache is refreshed on a timer and evicted on <code>updateQueue</code> / <code>deleteQueue</code>.'
        }
      ]
    },

    {
      id: 'partitioning',
      chapter: 'The data model',
      title: 'Partitioning, and how DDL fans out',
      body: `
<p><code>job</code> is declared <code>PARTITION BY LIST (name)</code>, so it holds no rows itself.
By default every queue's jobs land in <code>job_common</code>, the <code>DEFAULT</code> partition.
A queue created with <code>partition: true</code> gets a dedicated physical table instead.</p>

<p>The dedicated table is built inside the <code>create_queue()</code> plpgsql function, not from
TypeScript — so creating a queue is a single round trip even though it may involve creating a
table, five indexes, two foreign keys and a check constraint. The table name is
<code>'j' || sha224(queue_name)</code>, which sidesteps identifier length limits and illegal
characters in queue names.</p>

<p>Notice the <code>ELSIF</code> ladder near the end: a dedicated partition only gets the unique
index for <em>its own</em> policy, whereas <code>job_common</code> carries all of them (it holds
queues of every policy).</p>

<h2>The fan-out problem</h2>
<p>Once queues can have their own tables, any DDL change has to be applied to <em>N</em> tables
whose names you do not know at authoring time. Three plpgsql helpers solve that:</p>

<ul>
  <li><code>job_table_format(command, table_name)</code> — rewrites a command written against
  <code>.job</code> so it targets a specific partition, renaming <code>job_iN</code> indexes to
  match.</li>
  <li><code>job_table_run(command, …)</code> — runs a formatted command against
  <code>job_common</code> and every partitioned queue.</li>
  <li><code>job_table_run_async(…)</code> — the same fan-out, but queues the commands for the BAM
  worker instead of executing them (chapter 7).</li>
</ul>

<div class="callout"><p>The regexes in <code>job_table_format</code> are anchored, and the comment
above them explains why: a schema literally named <code>job_intake</code> was being mangled by the
unanchored version. <code>\\.job\\y</code> matches only the base table, never
<code>.job_dependency</code> or <code>job_i5</code>. The migration that fixed this (v37) carries
its own frozen copy of the old function — more on that in chapter 7.</p></div>
`,
      panels: [
        { kind: 'svg', name: 'partitioning' },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '278-298',
          text: `// Anchored so a schema name that itself contains these substrings (e.g. \`job_intake\`) isn't
// mangled: \`\\.job\\y\` matches only the base table reference (\`schema.job\`, not \`schema.job_i5\` whose
// \`job\` is followed by \`_\`, nor \`.job_dependency\`), and \`\\yjob_i(\\d+)\` matches only the bare
// index-name tokens (job_i1..9), never the \`job_i\` inside a schema name. Mirrors formatJobTable()
// in migrationStore.ts; the migration that fixed this (v37) carries its own frozen copy.
export function jobTableFormatFunction (schema: string) {
  return \`
    CREATE FUNCTION \${schema}.job_table_format(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\\\\.job\\\\y', '.%1$I', 'g'),
          '\\\\yjob_i(\\\\d+)', '%1$s_i\\\\1', 'g'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  \`
}`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '586-615',
          text: `      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE \${schema}.%I (LIKE \${schema}.job INCLUDING DEFAULTS)', tablename);

      EXECUTE \${schema}.job_table_format($cmd$\${createPrimaryKeyJob(schema)}$cmd$, tablename);
      EXECUTE \${schema}.job_table_format($cmd$\${createQueueForeignKeyJob(schema)}$cmd$, tablename);
      EXECUTE \${schema}.job_table_format($cmd$\${createQueueForeignKeyJobDeadLetter(schema)}$cmd$, tablename);

      EXECUTE \${schema}.job_table_format($cmd$\${createIndexJobFetch(schema)}$cmd$, tablename);
      EXECUTE \${schema}.job_table_format($cmd$\${createIndexJobThrottle(schema)}$cmd$, tablename);
      EXECUTE \${schema}.job_table_format($cmd$\${createIndexJobGroupConcurrency(schema)}$cmd$, tablename);
      EXECUTE \${schema}.job_table_format($cmd$\${createIndexJobBlocking(schema)}$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE \${schema}.job_table_format($cmd$\${createIndexJobPolicyShort(schema)}$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE \${schema}.job_table_format($cmd$\${createIndexJobPolicySingleton(schema)}$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE \${schema}.job_table_format($cmd$\${createIndexJobPolicyStately(schema)}$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE \${schema}.job_table_format($cmd$\${createIndexJobPolicyExclusive(schema)}$cmd$, tablename);
      ELSIF options->>'policy' = '\${QUEUE_POLICIES.key_strict_fifo}' THEN
        EXECUTE \${schema}.job_table_format($cmd$\${createIndexJobPolicyKeyStrictFifo(schema)}$cmd$, tablename);
        EXECUTE \${schema}.job_table_format($cmd$\${createCheckConstraintKeyStrictFifo(schema)}$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE \${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE \${schema}.job ATTACH PARTITION \${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);`,
          note: 'The tail of <code>create_queue()</code>. Everything above this point inserted the queue row; if that was a no-op, or the queue is not partitioned, it returns early.'
        }
      ]
    },

    {
      id: 'queue-policies',
      chapter: 'The data model',
      title: 'Policies are enforced by indexes, not by code',
      body: `
<p>A queue has a <code>policy</code>, and the policy decides how many jobs may exist in which
states for a given <code>singleton_key</code>. There are six.</p>

<table>
  <tr><th>Policy</th><th>Enforced by</th><th>Meaning</th></tr>
  <tr><td><code>standard</code></td><td>—</td><td>No constraint at all</td></tr>
  <tr><td><code>short</code></td><td><code>job_i1</code></td><td>One <em>created</em> job per key</td></tr>
  <tr><td><code>singleton</code></td><td><code>job_i2</code></td><td>One <em>active</em> job per key</td></tr>
  <tr><td><code>stately</code></td><td><code>job_i3</code></td><td>One per key <em>in each state</em> up to active</td></tr>
  <tr><td><code>exclusive</code></td><td><code>job_i6</code></td><td>One per key across created + retry + active</td></tr>
  <tr><td><code>key_strict_fifo</code></td><td><code>job_i8</code> + a CHECK</td><td>One per key across active, retry and failed</td></tr>
</table>

<p>Look at what the enforcement actually is: a <strong>partial unique index</strong> whose
<code>WHERE</code> clause encodes the policy. No TypeScript checks any of this. The manager inserts
and lets the database decide.</p>

<div class="callout"><p>This is why so many write paths end in <code>ON CONFLICT DO NOTHING</code>
and then inspect the row count. "Did the policy allow this job?" is answered by whether the insert
produced a row.</p></div>

<h2>The consequence you must remember</h2>
<p>These indexes key on <code>state</code>. So a job changing state can change whether it conflicts.
That is precisely why failing a job is implemented as a <code>DELETE</code> followed by an
<code>INSERT</code> rather than an <code>UPDATE</code> — the re-insert is what re-checks the
policy. We will read that query in chapter 4.</p>

<h2>The two non-policy indexes worth knowing</h2>
<ul>
  <li><code>job_i5</code> — the fetch index: <code>(name, start_after) WHERE state &lt; 'active'
  AND NOT blocked</code>. It matches the fetch predicate exactly.</li>
  <li><code>job_i9</code> — the flow resolver's index, deliberately empty for anyone not using
  flows.</li>
</ul>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '46-62',
          text: `export const JOB_STATES = Object.freeze({
  created: 'created',
  retry: 'retry',
  active: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed'
})

export const QUEUE_POLICIES = Object.freeze({
  standard: 'standard',
  short: 'short',
  singleton: 'singleton',
  stately: 'stately',
  exclusive: 'exclusive',
  key_strict_fifo: 'key_strict_fifo'
})`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '707-721',
          text: `function createIndexJobPolicyShort (schema: string) {
  return \`CREATE UNIQUE INDEX job_i1 ON \${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = '\${JOB_STATES.created}' AND policy = '\${QUEUE_POLICIES.short}'\`
}

function createIndexJobPolicySingleton (schema: string) {
  return \`CREATE UNIQUE INDEX job_i2 ON \${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = '\${JOB_STATES.active}' AND policy = '\${QUEUE_POLICIES.singleton}'\`
}

function createIndexJobPolicyStately (schema: string) {
  return \`CREATE UNIQUE INDEX job_i3 ON \${schema}.job (name, state, COALESCE(singleton_key, '')) WHERE state <= '\${JOB_STATES.active}' AND policy = '\${QUEUE_POLICIES.stately}'\`
}

function createIndexJobThrottle (schema: string) {
  return \`CREATE UNIQUE INDEX job_i4 ON \${schema}.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> '\${JOB_STATES.cancelled}' AND singleton_on IS NOT NULL\`
}`,
          note: '<code>job_i4</code> is not a policy index — it is how <code>sendThrottled</code> and <code>sendDebounced</code> collapse a time slot into one job.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '723-730',
          text: `function createIndexJobFetch (schema: string, noCoveringIndex = false) {
  // No covering INCLUDE: the fetch locks candidate rows with FOR UPDATE ... SKIP LOCKED, which
  // forces heap access, so an index-only scan is impossible and a covering payload would never be
  // read from the index. Confirmed dead weight via EXPLAIN ANALYZE;
  // dropping it shrinks job_i5 on the hot insert path at no read-side cost.
  // noCoveringIndex (the CockroachDB profile flag that stripped the old INCLUDE) is now moot here.
  return \`CREATE INDEX job_i5 ON \${schema}.job (name, start_after) WHERE state < '\${JOB_STATES.active}' AND NOT blocked\`
}`,
          note: 'A good example of the comment style here: it explains why the obvious optimisation was <em>removed</em>.'
        }
      ],
      quiz: {
        q: 'A queue uses <code>policy: &#39;singleton&#39;</code>. Two <code>send()</code> calls with the same <code>singletonKey</code> arrive while no job is running. What happens?',
        options: [
          'The second is rejected — <code>singleton</code> allows one job per key, period',
          'Both are created. <code>job_i2</code> only constrains the <code>active</code> state, so two <code>created</code> rows are legal',
          'The second overwrites the first',
          '<code>manager.ts</code> checks the policy in JavaScript and throws'
        ],
        answer: 1,
        explain: 'Both rows are created. <code>job_i2</code> is <code>WHERE state = &#39;active&#39;</code>, so it only prevents a second job from becoming <em>active</em> while one is running. Reading the index predicate is the only reliable way to know what a policy does — and it is why <code>short</code>, <code>singleton</code>, <code>stately</code> and <code>exclusive</code> exist as separate options at all.'
      }
    },

    /* ================= Ch 3 · Producing jobs ================= */

    {
      id: 'insert-jobs',
      chapter: 'Producing jobs',
      title: 'One INSERT does all the work',
      body: `
<p><code>send()</code> creates one job. <code>insert()</code> creates thousands. They are the same
SQL statement, because the payload arrives as JSON and is expanded with
<code>json_to_recordset($1::json)</code>. One round trip, one plan, any batch size.</p>

<p>Three things are happening in that statement, and each is worth recognising on sight.</p>

<h2>1. The COALESCE cascade</h2>
<p><code>JOIN queue q ON q.name = '…'</code> brings the queue's defaults into scope, and every
inheritable setting is written as <code>COALESCE(perJobOption, q.column)</code>. That is the entire
implementation of "job options override queue defaults" — there is no merging in JavaScript. It
also means the resulting job row is <strong>self-contained</strong>: later changes to the queue do
not affect jobs already created.</p>

<h2>2. startAfter is parsed in SQL</h2>
<p>A trailing <code>Z</code> means an ISO timestamp; anything else is treated as an interval from
<code>now()</code>. Doing this in the database rather than in Node means the client's clock never
enters into it.</p>

<h2>3. ON CONFLICT DO NOTHING is the policy check</h2>
<p>Remember the partial unique indexes. This clause is where they take effect. If the policy
forbids the job, the insert quietly produces no row — and the caller learns that from the
<em>row count</em>, not from an error.</p>

<div class="callout"><p><code>singleton_on</code> is computed with a floor division that snaps
<code>now()</code> to a fixed time slot. That single expression is how
<code>sendThrottled</code> and <code>sendDebounced</code> work: two sends in the same slot produce
the same <code>singleton_on</code>, and <code>job_i4</code> rejects the second.</p></div>

<h2>The NOTIFY wrapper</h2>
<p>When a queue opts into <code>notify</code>, the insert is wrapped in a CTE that fires exactly
one <code>pg_notify</code> — and only if at least one inserted row is <em>immediately</em>
runnable. Future-dated and throttled jobs are deliberately left to the polling floor, because
waking a worker for a job it cannot claim yet is pure waste.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1696-1721',
          text: `    SELECT
      COALESCE(id, gen_random_uuid()) as id,
      '\${name}' as name,
      data,
      COALESCE(priority, 0) as priority,
      j.start_after,
      "singletonKey",
      CASE
        WHEN "singletonSeconds" IS NOT NULL THEN 'epoch'::timestamp + '1s'::interval * ("singletonSeconds"::float8 * floor(( date_part('epoch', now()) + COALESCE("singletonOffset",0)::float8) / "singletonSeconds"::float8 ))
        ELSE NULL
        END as singleton_on,
      "groupId" as group_id,
      "groupTier" as group_tier,
      COALESCE("expireInSeconds", q.expire_seconds) as expire_seconds,
      COALESCE("deleteAfterSeconds", q.deletion_seconds) as deletion_seconds,
      j.start_after + (COALESCE("retentionSeconds", q.retention_seconds) * interval '1s') as keep_until,
      COALESCE("retryLimit", q.retry_limit) as retry_limit,
      COALESCE("retryDelay", q.retry_delay) as retry_delay,
      COALESCE("retryBackoff", q.retry_backoff, false) as retry_backoff,
      COALESCE("retryDelayMax", q.retry_delay_max) as retry_delay_max,
      q.policy,
      COALESCE("deadLetter", q.dead_letter) as dead_letter,
      COALESCE("heartbeatSeconds", q.heartbeat_seconds) as heartbeat_seconds,
      COALESCE(blocked, false) as blocked,
      COALESCE(blocking, false) as blocking,
      COALESCE("pendingDependencies", 0) as pending_dependencies`,
          note: 'Every <code>COALESCE(x, q.y)</code> is one line of the option-inheritance spec.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1722-1754',
          text: `    FROM (
      SELECT *,
        CASE
          WHEN right("startAfter", 1) = 'Z' THEN CAST("startAfter" as timestamp with time zone)
          ELSE now() + CAST(COALESCE("startAfter",'0') as interval)
          END as start_after
      FROM json_to_recordset($1::json) as x (
        id uuid,
        priority integer,
        data jsonb,
        "startAfter" text,
        "retryLimit" integer,
        "retryDelay" integer,
        "retryDelayMax" integer,
        "retryBackoff" boolean,
        "singletonKey" text,
        "singletonSeconds" integer,
        "singletonOffset" integer,
        "groupId" text,
        "groupTier" text,
        "expireInSeconds" integer,
        "deleteAfterSeconds" integer,
        "retentionSeconds" integer,
        "deadLetter" text,
        "heartbeatSeconds" integer,
        blocked boolean,
        blocking boolean,
        "pendingDependencies" integer
      )
    ) j
    JOIN \${schema}.queue q ON q.name = '\${name}'
    ON CONFLICT DO NOTHING
    \${returning}`,
          note: 'This column list is the wire format of <code>JobInsert</code>. Adding a job option means adding it here, in the SELECT above, and in <code>types.ts</code>.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1761-1777',
          text: `  // Fire a single transactional NOTIFY (committed atomically with the insert) only when
  // at least one inserted row is immediately runnable. Future-dated/throttled jobs are
  // left to the polling floor. The \`notified\` CTE is referenced from the final WHERE so
  // Postgres actually evaluates it; pg_notify runs at most once thanks to LIMIT 1. The
  // comparator shapes the output rows to honor returnId without changing notify behavior.
  const comparator = returnId ? '>= 0' : '< 0'

  return \`
    WITH ins AS (
      \${insert}
    ),
    notified AS (
      SELECT pg_notify(\${notifyChannelSql(schema)}, '\${name}')
      FROM ins WHERE start_after <= now() LIMIT 1
    )
    SELECT id FROM ins WHERE (SELECT count(*) FROM notified) \${comparator}
  \``
        }
      ]
    },

    {
      id: 'producer-path',
      chapter: 'Producing jobs',
      title: 'The producer path, and debouncing',
      body: `
<p><code>createJob</code> is the single funnel every one-job producer goes through:
<code>send</code>, <code>sendAfter</code>, <code>sendThrottled</code>, <code>sendDebounced</code>
and <code>publish</code> all normalise their arguments in <code>attorney.ts</code> and end up
here. The shape is the same five steps you will see in twenty other manager methods:</p>

<ol>
  <li>build the payload from validated options</li>
  <li>pick the database — <code>options.db</code> if the caller supplied one, otherwise the pool</li>
  <li><code>getQueueCache(name)</code> for <code>table</code>, <code>policy</code>, <code>notify</code></li>
  <li>build SQL with a <code>plans.*</code> builder</li>
  <li>execute, and interpret the row count</li>
</ol>

<h2>Bring your own transaction</h2>
<p>Step 2 is the whole story of transactional enqueue. Pass <code>{ db }</code> — anything
implementing <code>IDatabase</code>, including a wrapper around your ORM's transaction object — and
the job is created inside <em>your</em> transaction. It is not a special code path; it is the same
statement executed by a different handle. If your transaction rolls back, the job never existed.</p>

<h2>The two-attempt debounce</h2>
<p>The second half of <code>createJob</code> is the only genuinely subtle part. If the first insert
was skipped by <code>ON CONFLICT</code> and the caller asked for <code>singletonNextSlot</code>,
the job is retried with <code>startAfter</code> recomputed to the <em>next</em> throttle window,
using the clock skew the timekeeper measured against the database. That is the difference between
"throttle: drop the extra send" and "debounce: defer the extra send".</p>

<div class="callout"><p>Note the explicit guard at the top: a <code>key_strict_fifo</code> queue
requires a <code>singletonKey</code>. That check is in the manager rather than the attorney because
it depends on the <em>queue's</em> policy, which is only known after the cache lookup.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/manager.ts',
          lines: '935-962',
          text: `  async createJob (request: types.Request): Promise<string | null> {
    const { name, data = null, options = {} } = request
    const { db: wrapper, singletonSeconds, singletonNextSlot } = options

    const job = this.#toJobPayload(name, data, options)

    const db = wrapper || this.db

    const { table, policy, notify } = await this.getQueueCache(name)

    if (policy === plans.QUEUE_POLICIES.key_strict_fifo && !job.singletonKey) {
      throw new Error(\`\${plans.QUEUE_POLICIES.key_strict_fifo} queues require a singletonKey\`)
    }

    const sql = plans.insertJobs(this.config.schema, { table, name, returnId: true, notify: this.#notifyEnabled(notify) })

    const { rows: try1 } = await db.executeSql(sql, [JSON.stringify([job])])

    if (try1.length === 1) {
      const jobId = try1[0].id
      if (this.config.__test__enableSpies) {
        const spy = this.#spies.get(name)
        if (spy) {
          spy.addJob(jobId, name, data || {}, 'created')
        }
      }
      return jobId
    }`,
          note: '<code>try1.length === 1</code> — the row count <em>is</em> the answer to "did the policy allow this?".'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/manager.ts',
          lines: '964-984',
          text: `    if (singletonNextSlot) {
      // delay starting by the offset to honor throttling config
      job.startAfter = this.getDebounceStartAfter(singletonSeconds!, this.timekeeper!.clockSkew)
      job.singletonOffset = singletonSeconds

      const { rows: try2 } = await db.executeSql(sql, [JSON.stringify([job])])

      if (try2.length === 1) {
        const jobId = try2[0].id
        if (this.config.__test__enableSpies) {
          const spy = this.#spies.get(name)
          if (spy) {
            spy.addJob(jobId, name, data || {}, 'created')
          }
        }
        return jobId
      }
    }

    return null
  }`,
          note: 'Returning <code>null</code> rather than throwing is the contract: "the policy declined this job" is a normal outcome.'
        }
      ]
    },

    {
      id: 'flow',
      chapter: 'Producing jobs',
      title: 'flow(): a DAG of jobs',
      body: `
<p><code>flow()</code> takes a flat array of <code>FlowJob</code>s — each with a caller-local
<code>ref</code> and an optional <code>dependsOn: string[]</code> — and creates them all, wired
together, atomically.</p>

<h2>Validation rejects cycles up front</h2>
<p><code>attorney.validateFlowJobs</code> runs a Kahn topological sort. If the number of visited
nodes does not equal the number of jobs, there is a cycle, and a second pass
(<code>findDependencyCycle</code>) walks the graph again just to produce a readable
<code>a -&gt; b -&gt; c -&gt; a</code> in the error message. Spending a second traversal on the
error path only is a nice pattern to copy.</p>

<h2>Building the batch</h2>
<p>Ids are assigned in JavaScript <em>before</em> anything is inserted — <code>randomUUID()</code>
per ref. That is what makes the dependency rows writable in the same batch: you cannot reference a
row's id if the database is the one generating it. Each job then carries three derived columns:
<code>blocked</code> (it has parents), <code>blocking</code> (it has children), and
<code>pending_dependencies</code> (how many parents remain).</p>

<h2>Why the statement has no parameters</h2>
<p>The whole flow is emitted as one parameter-less multi-statement string with the payload
serialised inline. That guarantees it commits atomically through <em>any</em>
<code>IDatabase</code>, including adapters with no transaction support of their own. Each insert is
wrapped in a guard that computes <code>1 / (CASE WHEN count = expected THEN 1 ELSE 0 END)</code>:
if a policy silently skipped a row, the division by zero aborts the whole flow instead of leaving a
half-built graph. The divisor references the row count specifically so the planner cannot fold it
away.</p>

<div class="callout warn"><p>A flow's child stays blocked <strong>forever</strong> if its parent
ends up failed or cancelled. Nothing unblocks it automatically — that is a deliberate choice, and
handling it is the application's job.</p></div>
`,
      panels: [
        { kind: 'svg', name: 'flow-dag' },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/attorney.ts',
          lines: '247-278',
          text: `  // Cycle detection via topological sort
  const inDegree = new Map<string, number>()
  const edges = new Map<string, string[]>()
  for (const job of jobs) {
    inDegree.set(job.ref, 0)
    edges.set(job.ref, [])
  }
  for (const job of jobs) {
    if (!job.dependsOn) continue
    for (const dep of job.dependsOn) {
      edges.get(dep)!.push(job.ref)
      inDegree.set(job.ref, inDegree.get(job.ref)! + 1)
    }
  }
  const queue: string[] = []
  for (const [ref, deg] of inDegree) {
    if (deg === 0) queue.push(ref)
  }
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    visited++
    for (const child of edges.get(current)!) {
      const newDeg = inDegree.get(child)! - 1
      inDegree.set(child, newDeg)
      if (newDeg === 0) queue.push(child)
    }
  }
  if (visited !== jobs.length) {
    const cycle = findDependencyCycle(edges)
    assert(false, \`flow contains a dependency cycle: \${cycle.join(' -> ')}\`)
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1780-1795',
          text: `// Self-contained (parameter-less) insert for one queue's slice of a flow batch. The JSON
// payload is embedded directly so the whole flow can be sent as a single multi-statement
// round-trip regardless of db adapter. Guarded so a skipped row (ON CONFLICT) raises
// 'division by zero', aborting the surrounding transaction. The divisor references the
// row count so it isn't constant-folded at plan time.
export function insertFlowJobs (schema: string, { table, name }: { table: string, name: string }, jobs: unknown[]): string {
  const insert = insertJobs(schema, { table, name, returnId: true })
    .replace('$1', () => serializeJsonParam(jobs))

  return \`
    WITH ins AS (
      \${insert}
    )
    SELECT 1 / (CASE WHEN (SELECT count(*) FROM ins) = \${jobs.length} THEN 1 ELSE 0 END)
  \`
}`,
          note: 'Deliberately raising <em>division by zero</em> as a control-flow signal shows up twice in this codebase — the other is the migration race guard in chapter 7.'
        }
      ]
    },

    /* ================= Ch 4 · Consuming jobs ================= */

    {
      id: 'fetch-skip-locked',
      chapter: 'Consuming jobs',
      title: 'fetch(): claiming a job',
      body: `
<p>This is the query the whole library is built around. Strip away the optional group-concurrency
and singleton branches and it is one statement with two halves.</p>

<p><strong>The <code>next</code> CTE</strong> selects candidate ids: right queue, fetchable state,
not blocked, eligible by time — ordered by priority then age, limited to the batch size, and
<code>FOR UPDATE OF j SKIP LOCKED</code>. <strong>The <code>UPDATE</code></strong> then flips those
rows to <code>active</code>, stamps <code>started_on</code> and <code>heartbeat_on</code>, and
returns the job columns.</p>

<h2>Details that are easy to miss</h2>
<ul>
  <li><code>state &lt; 'active'</code> — one comparison covering both <code>created</code> and
  <code>retry</code>, thanks to the enum ordering.</li>
  <li><code>start_after &lt;= now()</code>, not <code>&lt;</code>. The comment explains why: a job
  inserted with the default <code>start_after = now()</code> must be fetchable by the very next
  statement, and on backends with coarse clock resolution consecutive statements can share a
  timestamp.</li>
  <li><code>retry_count</code> is incremented <em>on fetch</em>, but only if
  <code>started_on IS NOT NULL</code> — i.e. only on a re-delivery, not a first delivery.</li>
  <li>The index this is written for is <code>job_i5</code>:
  <code>(name, start_after) WHERE state &lt; 'active' AND NOT blocked</code>. The predicate matches
  the WHERE clause term for term, which is the point.</li>
</ul>

<div class="callout"><p>Claiming a job is a <em>write</em>. There is no separate "reserve then
confirm" protocol, no visibility timeout to configure, and no message that can be redelivered
because an ack was lost. The row is either <code>active</code> or it is not.</p></div>
`,
      panels: [
        { kind: 'svg', name: 'fetch-race' },
        {
          kind: 'code',
          lang: 'sql',
          label: 'what it renders to, in the simple case',
          text: `WITH
  next AS (
    SELECT j.id
    FROM pgboss.job_common j
    WHERE j.name = 'email'
      AND j.state < 'active'
      AND NOT j.blocked
      AND j.start_after <= now()
    ORDER BY j.priority desc, j.created_on, j.id
    LIMIT 1
    FOR UPDATE OF j SKIP LOCKED
  )
UPDATE pgboss.job_common j SET
  state = 'active',
  started_on = now(),
  heartbeat_on = now(),
  retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
FROM next
WHERE name = 'email' AND j.id = next.id
RETURNING j.id, name, data, expire_seconds as "expireInSeconds", …`,
          note: 'Illustrative rendering — the builder below is the real source.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1426-1451',
          text: `  const whereConditions = [
    \`j.name = '\${name}'\`,
    \`j.state < '\${JOB_STATES.active}'\`,
    'NOT j.blocked',
    // \`<=\` (not \`<\`) so a job inserted with the default start_after = now() is immediately
    // fetchable in the next statement. \`now()\` is transaction-scoped; on backends with coarse
    // clock resolution (notably PGlite) consecutive autocommit statements often share the same
    // timestamp, so \`<\` would leave freshly-inserted jobs invisible until the clock ticks.
    // NOTIFY gating already uses \`start_after <= now()\` for the same reason.
    !ignoreStartAfter ? 'j.start_after <= now()' : '',
    hasIgnoreSingletons ? \`COALESCE(j.singleton_key, '') <> ALL(\${params.ignoreSingletonsParam})\` : '',
    hasIgnoreGroups ? \`(j.group_id IS NULL OR j.group_id <> ALL(\${params.ignoreGroupsParam}))\` : '',
    hasMinPriority ? \`j.priority >= \${params.minPriorityParam}\` : '',
    hasMaxPriority ? \`j.priority <= \${params.maxPriorityParam}\` : '',
    groupConcurrencyFilter
  ].filter(Boolean).join('\\n          AND ')

  const nextCte = \`
      next AS (
        SELECT \${selectCols}
        FROM \${schema}.\${table} j
        WHERE \${whereConditions}
        ORDER BY \${priority ? 'j.priority desc, ' : ''}\${orderByCreatedOn ? 'j.created_on, ' : ''}j.id
        LIMIT \${limit}
        \${lockClause}
      )\``,
          note: 'Optional conditions are built as an array and <code>filter(Boolean)</code>ed — the standard shape for conditional SQL in this file.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1499-1515',
          text: `    text: \`
      WITH
      \${activeGroupCountMapCte}
      \${nextCte}
      \${singletonCte}
      \${groupConcurrencyCtes}
      UPDATE \${schema}.\${table} j SET
        state = '\${JOB_STATES.active}',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      \${updateSource}
      WHERE name = '\${name}' AND \${updateMatch}
      \${singletonFetch && !hasGroupConcurrency ? 'AND singleton_rn = 1' : ''}
      \${distributedStateCheck}
      RETURNING j.\${includeMetadata ? JOB_COLUMNS_ALL : JOB_COLUMNS_MIN}
    \`,`
        }
      ]
    },

    {
      id: 'no-skip-locked',
      chapter: 'Consuming jobs',
      title: 'The variant for engines without SKIP LOCKED',
      body: `
<p>CockroachDB implements <code>SKIP LOCKED</code>, but it performs poorly there and can skip rows
that are not actually locked. So the <code>noSkipLocked</code> profile takes a different approach,
and the difference is remarkably small: <strong>drop the lock clause, and add a state recheck to
the <code>UPDATE</code>.</strong></p>

<p>That recheck is what preserves correctness. Without the lock, two workers can select the same
candidate id. But only one <code>UPDATE</code> can win, because the second one's
<code>AND j.state &lt; 'active'</code> no longer matches a row the first already flipped. The loser
gets zero rows back — an empty fetch, not a duplicate delivery.</p>

<div class="callout"><p>The trade-off is stated plainly in the doc comment: under contention,
workers get fewer jobs per fetch. That is acceptable because processing time normally dwarfs fetch
time. Losing a race costs one wasted round trip, not a duplicated job.</p></div>

<h2>The one error fetch is allowed to swallow</h2>
<p>A concurrent fetch can lose a policy race and raise SQLSTATE <code>23505</code>
(unique violation). That is a legitimate empty fetch. <strong>Every other error is rethrown.</strong>
The comment records why the narrow check exists: a broad catch here turned every failed fetch —
including a database outage — into a silent <code>[]</code>, indistinguishable from an empty queue,
with no <code>error</code> event.</p>

<div class="callout warn"><p>This is also the reason the Bun adapter has to move SQLSTATE from
<code>err.errno</code> onto <code>err.code</code>. Real behaviour is keyed on that string.</p></div>

<p>You can exercise this whole path on ordinary Postgres with
<code>bun run test:distributed</code>, which sets the <code>__test__distributed</code> hook you saw
in <code>resolveBackend</code>.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1341-1356',
          text: `/**
 * Builds the fetch query for claiming jobs from the queue.
 *
 * With SKIP LOCKED (noSkipLocked=false, the default), uses SELECT FOR UPDATE SKIP
 * LOCKED, which lets multiple workers efficiently fetch different jobs simultaneously.
 *
 * With noSkipLocked=true, omits FOR UPDATE SKIP LOCKED and adds an additional state
 * check in the WHERE clause. This pattern works better with distributed databases like
 * CockroachDB where SKIP LOCKED has performance issues and can unexpectedly skip
 * unlocked rows.
 *
 * Trade-off when noSkipLocked is set: under high contention, workers may receive fewer
 * jobs per fetch as concurrent updates to the same rows will result in some workers
 * getting empty results. This is acceptable for job queues where processing time
 * exceeds fetch time.
 */`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1405-1407',
          text: `  // With noSkipLocked, omit FOR UPDATE SKIP LOCKED as it performs poorly
  // in distributed databases like CockroachDB
  const lockClause = noSkipLocked ? '' : 'FOR UPDATE OF j SKIP LOCKED'`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1494-1496',
          text: `  // Without SKIP LOCKED, add a state check to prevent duplicate processing
  // when multiple workers try to claim the same jobs concurrently
  const distributedStateCheck = noSkipLocked ? \`AND j.state < '\${JOB_STATES.active}'\` : ''`,
          note: 'Two variables. That is the entire second fetch strategy.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/manager.ts',
          lines: '1344-1353',
          text: `    try {
      result = await db.executeSql(query.text, query.values)
    } catch (err: any) {
      // The only fetch error we tolerate is a unique-constraint violation (SQLSTATE 23505) from a
      // policy/singleton index when a concurrent fetch won the same slot — treat that as an empty
      // fetch. Anything else (a DB outage, a malformed query) must surface: swallowing it turned
      // every failed fetch into a silent [] with no error event, indistinguishable from an empty
      // queue. Rethrowing routes it to the worker's onError (emits \`error\`) or to a direct caller.
      if (err?.code !== '23505') throw err
    }`
        }
      ]
    },

    {
      id: 'worker-loop',
      chapter: 'Consuming jobs',
      title: 'worker.ts knows nothing about the database',
      body: `
<p>166 lines, and not one <code>import</code> of <code>db</code> or <code>plans</code>. A
<code>Worker</code> receives four closures — <code>fetch</code>, <code>onFetch</code>,
<code>onError</code>, <code>resolveInterval</code> — and does nothing but drive them in a loop.
Manager supplies the meaning; Worker supplies the timing.</p>

<p>Read the loop and notice what it protects against:</p>

<ul>
  <li><strong><code>fetchedCount</code> stays 0 on error.</strong> Burst mode only engages while
  fetches come back full, so a <em>failing</em> fetch cannot be mistaken for a busy queue. Without
  this, an outage would turn into a hot loop hammering a broken database.</li>
  <li><strong>The delay is skipped when it would be pointless.</strong> If the resolved interval is
  within 100ms of how long the iteration already took, re-fetch immediately rather than sleeping
  for a few milliseconds.</li>
  <li><strong><code>beenNotified</code> is reset before the fetch, not after.</strong> A NOTIFY
  arriving <em>during</em> a fetch still counts, so the worker skips its next sleep instead of
  losing the wakeup.</li>
</ul>

<h2>Stopping is the same mechanism as waking</h2>
<p>Both <code>notify()</code> and <code>stop()</code> abort the pending delay promise. Sleeping is
therefore always interruptible, and <code>stop()</code> awaits the loop's own promise so it returns
only once the iteration has genuinely finished.</p>

<div class="callout"><p>Everything else in the class is telemetry — <code>lastFetchedOn</code>,
<code>lastJobDuration</code>, <code>lastError</code> — surfaced through
<code>toWipData()</code> and the <code>wip</code> event. That is what
<code>boss.getWipData()</code> reads.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/worker.ts',
          lines: '11-20',
          text: `interface WorkerOptions<T> {
  id: string
  workId: string
  name: string
  options: types.WorkOptions
  resolveInterval: (lastFetchCount: number) => number
  fetch: () => Promise<types.Job<T>[]>
  onFetch: (jobs: types.Job<T>[]) => Promise<void>
  onError: (err: any) => void
}`,
          note: 'The dependency-injection seam. This interface is why the file has no database imports.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/worker.ts',
          lines: '66-115',
          text: `    while (!this.stopping) {
      const started = Date.now()

      // Number of jobs the last fetch returned; stays 0 on error so a failed fetch backs
      // off to normal polling instead of hot-looping in burst mode.
      let fetchedCount = 0

      try {
        this.beenNotified = false
        const jobs = await this.fetch()

        this.lastFetchedOn = Date.now()

        if (jobs) {
          fetchedCount = jobs.length
          this.jobs = jobs

          this.lastJobStartedOn = this.lastFetchedOn

          await this.onFetch(jobs)

          this.lastJobEndedOn = Date.now()

          this.jobs = []
        }
      } catch (err: any) {
        this.lastErrorOn = Date.now()
        this.lastError = err

        err.message = \`\${err.message} (Queue: \${this.name}, Worker: \${this.id})\`

        this.onError(err)
      }

      const duration = Date.now() - started

      this.lastJobDuration = duration

      // Resolve the effective delay each iteration: burst (continuous), NOTIFY backstop, or
      // the base poll (see Manager.work). fetchedCount lets the resolver keep going only while
      // fetches come back full — a short fetch resumes normal polling. A returned interval
      // <= duration + 100 (0 in burst mode) skips the delay and re-fetches immediately.
      const interval = this.resolveInterval(fetchedCount)

      if (!this.stopping && !this.beenNotified && (interval - duration) > 100) {
        this.loopDelayPromise = delay(interval - duration)
        await this.loopDelayPromise
        this.loopDelayPromise = null
      }
    }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/worker.ts',
          lines: '122-128',
          text: `  notify () {
    this.beenNotified = true

    if (this.loopDelayPromise) {
      this.loopDelayPromise.abort()
    }
  }`
        }
      ]
    },

    {
      id: 'work',
      chapter: 'Consuming jobs',
      title: 'work() wires the loop to the database',
      body: `
<p><code>work()</code> is where the four closures are built. It also decides polling cadence and
spawns however many loops <code>localConcurrency</code> asks for — all sharing the
<em>first</em> worker's id as their <code>workId</code>, which is what <code>offWork()</code>
later matches on. That is why <code>work()</code> returns one id even when it started eight loops.</p>

<h2>resolveInterval: the cadence brain</h2>
<p>Precedence is <strong>burst &gt; NOTIFY backstop &gt; base poll</strong>, evaluated fresh on
every iteration so it tracks live queue state. Burst mode only engages while the last fetch came
back <em>full</em>; a short fetch means the queue has probably caught up, so it drops back to
normal polling rather than spinning on empty fetches.</p>

<h2>Settlement</h2>
<p>The handler is run under <code>resolveWithinSeconds</code> with the batch's maximum
<code>expireInSeconds</code>, and an <code>AbortController</code> whose signal is attached to every
job. Return normally and the batch is completed; throw and it is failed. The <code>finally</code>
clears the heartbeat timer.</p>

<div class="callout"><p>The heartbeat cadence uses <code>Math.min</code> of the batch, not
<code>Math.max</code> — and the comment explains why. Heartbeat expiry is evaluated per job against
its own <code>heartbeat_seconds</code>, so a cadence derived from the batch maximum would let a
short-heartbeat job go stale and be failed out from under a still-running handler.</p></div>

<h2>Three concurrency knobs</h2>
<ul>
  <li><code>localConcurrency</code> — how many polling loops this process runs.</li>
  <li><code>localGroupConcurrency</code> — in-memory cap per <code>group.id</code>, enforced by
  excluding at-capacity groups from the fetch and restoring any excess.</li>
  <li><code>groupConcurrency</code> — the same idea enforced <em>in SQL</em>, so it holds across
  every process. That is the branch that adds the extra CTEs you saw in the fetch builder.</li>
</ul>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/manager.ts',
          lines: '644-662',
          text: `    // Resolve the delay before each fetch. Precedence: burst (fetch continuously) > NOTIFY
    // backstop > base poll. Evaluated per-iteration so it tracks live cache/notify state and
    // any updateQueue notify toggles.
    //
    // A burst trigger only engages while the last fetch came back full (>= batchSize). That is
    // both the meaning of burstWhenBatchFull and the anti-hot-loop guard for burstWhenReadyExceeds:
    // the cached ready count lags reality, so a short fetch (including 0 < 1 at the default batchSize)
    // means the queue has likely caught up — fall back to normal polling instead of spinning on
    // empty fetches. burstWhenBatchFull is ignored at batchSize 1 (every fetch would be "full").
    const resolveInterval = (lastFetchCount: number) => {
      const fullBatch = lastFetchCount >= batchSize
      const burst = fullBatch && (
        (burstWhenReadyExceeds !== undefined && getReadyCount() > burstWhenReadyExceeds) ||
        (burstWhenBatchFull && batchSize > 1)
      )

      if (burst) return 0
      return isNotifyActive() ? notifyInterval : interval
    }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/manager.ts',
          lines: '712-722',
          text: `    // Spawn workers based on localConcurrency setting
    for (let i = 0; i < localConcurrency; i++) {
      const workerId = i === 0 ? firstWorkerId : randomUUID({ disableEntropyCache: true })
      const worker = createWorker(workerId, firstWorkerId)

      this.addWorker(worker)
      worker.start()
    }

    return firstWorkerId
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/manager.ts',
          lines: '450-456',
          text: `    const maxExpiration = jobs.reduce((acc, i) => Math.max(acc, i.expireInSeconds), 0)
    // Minimum, not maximum: heartbeatSeconds is per-job, and failJobsByHeartbeat fails a job once
    // its OWN heartbeat_on is stale by ITS OWN heartbeat_seconds. A refresh cadence derived from
    // the batch max would let a small-heartbeat job in a mixed batch go stale and get failed out
    // from under a still-running handler before the shared timer ever touches it.
    const heartbeatCandidates = jobs.map(j => j.heartbeatSeconds || 0).filter(s => s > 0)
    const heartbeatSeconds = heartbeatCandidates.length ? Math.min(...heartbeatCandidates) : 0`,
          note: 'Note the asymmetry: <code>max</code> for expiration (the batch is done when the slowest job is), <code>min</code> for heartbeat.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/manager.ts',
          lines: '484-506',
          text: `    try {
      const result = await resolveWithinSeconds(callback(jobs), maxExpiration, \`handler execution exceeded \${maxExpiration}s\`, ac)
      if (perJobResults) {
        // #settlePerJob settles each job individually and does its own (synchronous,
        // lookup-free) spy tracking via #trackJobsSettled, so the deferred tracker below
        // is skipped for this path.
        await this.#settlePerJob(name, jobs, result)
      } else {
        const completion = await this.complete(name, jobIds, jobIds.length === 1 ? result : undefined)
        completedResult = result
        completedAffected = completion.affected
      }
    } catch (err: any) {
      await this.fail(name, jobIds, err)
      failedError = err
      didFail = true
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (worker) {
        // Clear between jobs
        worker.abortController = null
      }
    }`,
          note: 'The entire contract of a work handler: return to complete, throw to fail.'
        }
      ]
    },

    {
      id: 'settling',
      chapter: 'Consuming jobs',
      title: 'complete() is trivial. fail() is not.',
      body: `
<p>Completing a job is one <code>UPDATE</code> wrapped in a CTE purely so the statement can return
a count. It touches nothing else — and the comment above it says why in so many words:</p>

<div class="callout"><p>Dependency unblocking is intentionally <em>not</em> done here. Completion is
the hot path; chasing dependents inline made completion scale with partition count (issue #824).
The background resolver handles unblocking out of band.</p></div>

<h2>Failing deletes and re-inserts</h2>
<p><code>failJobsBody</code> is the most interesting SQL in the codebase. It does not update the
row. It <strong>deletes it, capturing the whole row in a CTE, then inserts it back</strong> — as
<code>retry</code> if attempts remain, otherwise as <code>failed</code>.</p>

<p>The reason goes back to chapter 2: the policy indexes are partial on <code>state</code>. A
plain <code>UPDATE</code> would move a row into a new state without ever re-testing whether the
policy permits a row in that state. The re-<code>INSERT</code> does re-test it, and
<code>ON CONFLICT DO NOTHING</code> is the enforcement point.</p>

<h2>The backoff expression</h2>
<p>Three cases in one <code>CASE</code>: no more retries (keep <code>start_after</code>), no
backoff configured (a flat delay), or exponential backoff — capped at <code>retry_delay_max</code>,
with the exponent clamped to 16 to prevent overflow, and <strong>half the delay randomised</strong>.
That jitter is what stops a batch of jobs that failed together from retrying together forever.</p>

<h2>Dead-lettering</h2>
<p>A final CTE inserts a <em>new</em> job on the dead-letter queue for anything that ended up
<code>failed</code>, joining <code>queue</code> to pick up the target's own defaults, and recording
provenance in the four <code>source_*</code> columns. It is a fresh job, not a moved one — so it
gets the dead-letter queue's retry policy, not the original's.</p>
`,
      panels: [
        { kind: 'svg', name: 'fail-paths' },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1561-1573',
          text: `// Dependency unblocking is intentionally NOT done here. Completion is the hot path; chasing
// dependents inline (joining job_dependency and the partitioned job table) made completion
// scale with partition count (see issue #824). The background resolver (Navigator) handles
// unblocking out of band, driven by the job_i9 partial index.
export function completeJobs (schema: string, table: string, includeQueued?: boolean) {
  return \`
    WITH results AS (
      \${completeJobsUpdate(schema, table, includeQueued)}
      RETURNING 1
    )
    SELECT COUNT(*) FROM results
  \`
}`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1853-1869',
          text: `function failJobsBody (schema: string, table: string, where: string, output: string, forceTerminal = false) {
  const state = forceTerminal
    ? \`'\${JOB_STATES.failed}'::\${schema}.job_state\`
    : \`CASE
          WHEN retry_count < retry_limit THEN '\${JOB_STATES.retry}'::\${schema}.job_state
          ELSE '\${JOB_STATES.failed}'::\${schema}.job_state
          END\`
  const completedOn = forceTerminal
    ? 'now()'
    : 'CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END'

  return \`deleted_jobs AS (
      DELETE FROM \${schema}.\${table}
      WHERE \${where}
      RETURNING *
    ),
    retried_jobs AS (`,
          note: '<code>forceTerminal</code> is the per-job <code>deadletter</code> disposition: skip the retries and fail now.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1912-1921',
          text: `        CASE WHEN retry_count = retry_limit THEN start_after
             WHEN NOT retry_backoff THEN now() + retry_delay * interval '1'
             ELSE now() + LEAST(
               retry_delay_max,
               GREATEST(retry_delay, 1) * (
                2 ^ LEAST(16, retry_count + 1) / 2 +
                2 ^ LEAST(16, retry_count + 1) / 2 * random()
               )
             ) * interval '1s'
        END as start_after,`,
          note: 'Half fixed, half random — the standard "full jitter minus a bit" shape.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '2015-2037',
          text: `    dlq_jobs as (
      INSERT INTO \${schema}.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
        expire_seconds, source_name, source_id, source_created_on, source_retry_count, singleton_key, heartbeat_seconds)
      SELECT
        r.dead_letter,
        r.data,
        r.output,
        q.retry_limit,
        q.retry_backoff,
        q.retry_delay,
        now() + q.retention_seconds * interval '1s',
        q.deletion_seconds,
        q.expire_seconds,
        r.name,
        r.id,
        r.created_on,
        r.retry_count,
        r.singleton_key,
        r.heartbeat_seconds
      FROM results r
        JOIN \${schema}.queue q ON q.name = r.dead_letter
      WHERE state = '\${JOB_STATES.failed}'
    )\``
        }
      ],
      quiz: {
        q: 'Why does <code>fail()</code> DELETE the row and INSERT it again instead of running one UPDATE?',
        options: [
          'To reset the row\\u2019s physical location and avoid table bloat',
          'Because the partial unique policy indexes key on <code>state</code>, so re-inserting is what re-checks whether the policy allows a row in the new state',
          'Because Postgres cannot UPDATE a partitioned table',
          'To make the operation replicate correctly to standbys'
        ],
        answer: 1,
        explain: 'The policy indexes (<code>job_i1</code>, <code>job_i2</code>, <code>job_i3</code>, <code>job_i6</code>, <code>job_i8</code>) are partial on <code>state</code>. An UPDATE that moves a row into a new state would never test whether the policy permits a row in that state; the re-INSERT does, and <code>ON CONFLICT DO NOTHING</code> is where it is enforced. Postgres <em>can</em> update a partitioned table, and will even move the row between partitions — that is not the reason.'
      }
    },

    /* ================= Ch 5 · Background machinery ================= */

    {
      id: 'cadence-gate',
      chapter: 'Background machinery',
      title: 'One idiom coordinates every background poller',
      body: `
<p>Four subsystems run on timers — the supervisor, the cron timekeeper, the async-migration worker
and the flow resolver. Every instance of your application runs all four. So how do ten processes
avoid doing the same maintenance ten times?</p>

<p>With one conditional <code>UPDATE</code>:</p>

<p>Each poller tries to stamp a timestamp column, but only if enough time has passed since the last
stamp. <code>RETURNING true</code> means <strong>exactly one instance gets a row back</strong>; the
others get zero and skip the tick entirely. No leader election, no advisory lock held across the
work, no coordination service. Just a row that can only be claimed once per interval.</p>

<p>The columns live on the <code>version</code> table: <code>cron_on</code>, <code>bam_on</code>,
<code>flow_on</code>. The supervisor uses a per-queue variant instead —
<code>queue.monitor_on</code> and <code>queue.maintain_on</code> — because its work is per queue
and different queues can be maintained by different instances.</p>

<div class="callout"><p>The <code>COALESCE(column, now() - interval '1 week')</code> is what makes
the very first tick fire: a <code>NULL</code> column is treated as "a week ago", so the interval
test passes immediately.</p></div>

<h2>Every poller has an ungated twin</h2>
<p>Because a cadence gate makes behaviour hard to test and useless when
<code>supervise: false</code>, each subsystem also exposes a direct method that skips the gate but
still serialises against a concurrent run: <code>boss.supervise()</code> and
<code>boss.resolveFlow()</code>. Paired with the <code>isMaintaining()</code> /
<code>isResolvingFlow()</code> / <code>isBamWorking()</code> / <code>isCheckingSkew()</code> flags,
that is how the test suite drives background behaviour deterministically — and it is the pattern to
follow if you add a fifth poller.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '764-783',
          text: `export function trySetCronTime (schema: string, seconds: number) {
  return trySetTimestamp(schema, 'cron_on', seconds)
}

export function trySetBamTime (schema: string, seconds: number) {
  return trySetTimestamp(schema, 'bam_on', seconds)
}

export function trySetFlowTime (schema: string, seconds: number) {
  return trySetTimestamp(schema, 'flow_on', seconds)
}

function trySetTimestamp (schema: string, column: string, seconds: number) {
  return \`
    UPDATE \${schema}.version
    SET \${column} = now()
    WHERE EXTRACT( EPOCH FROM (now() - COALESCE(\${column}, now() - interval '1 week') ) ) > \${seconds}
    RETURNING true
  \`
}`,
          note: 'Twenty lines that replace an entire coordination layer.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/timekeeper.ts',
          lines: '152-176',
          text: `  async onCron () {
    try {
      if (this.stopped || this.timekeeping) return

      if (this.config.__test__force_cron_monitoring_error) {
        throw new Error(this.config.__test__force_cron_monitoring_error)
      }

      this.timekeeping = true

      const sql = plans.trySetCronTime(this.config.schema, this.config.cronMonitorIntervalSeconds)

      if (!this.stopped) {
        const { rows } = await this.db.executeSql(sql)

        if (!this.stopped && rows.length === 1) {
          await this.cron()
        }
      }
    } catch (err) {
      this.emit(this.events.error, err)
    } finally {
      this.timekeeping = false
    }
  }`,
          note: 'The shape every poller uses: guard on stopped/working, claim the gate, do the work, always clear the flag. <code>rows.length === 1</code> means "we won this tick".'
        }
      ]
    },

    {
      id: 'supervisor',
      chapter: 'Background machinery',
      title: 'boss.ts: the supervisor',
      body: `
<p>One <code>setInterval</code> at <code>superviseIntervalSeconds</code> drives everything. The
work splits in two: <strong><code>#monitor</code></strong> refreshes the cached queue counters,
raises backlog warnings and fails jobs that have expired or gone silent;
<strong><code>#maintain</code></strong> deletes jobs past retention, rolls the
<code>queue_stats</code> partitions and cleans up orphaned dependency rows.</p>

<h2>Three patterns worth stealing</h2>

<p><strong>Stopping waits for in-flight work.</strong> <code>stop()</code> clears the interval,
sets the flag, then spins on <code>while (this.#maintaining) await delay(10)</code>. Crude, and
exactly right: it means <code>boss.stop()</code> never returns while a maintenance pass is
half-done.</p>

<p><strong>Cross-cutting instrumentation in one place.</strong> Every query goes through
<code>#executeQuery</code>, which times it and raises a slow-query warning past a threshold. Adding
a query to the supervisor gets you that for free — which is also why you should not call
<code>db.executeSql</code> directly from here.</p>

<p><strong>Cooperative cancellation everywhere.</strong> Queues are grouped by <em>physical
table</em> (so a partitioned queue is maintained separately from the shared ones), then chunked 100
names at a time, with <code>if (this.#stopping) return</code> between every single step. A
maintenance pass over a thousand queues can be abandoned within one chunk.</p>

<div class="callout"><p>Grouping by <code>table</code> rather than by queue is the recurring shape
for anything that touches many queues at once. The flow resolver does the same. It keeps each
statement inside one partition, which is what makes partition pruning work.</p></div>
`,
      panels: [
        { kind: 'svg', name: 'supervise-loop' },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/boss.ts',
          lines: '57-77',
          text: `  async start () {
    if (this.#stopped) {
      this.#stopping = false
      this.#superviseInterval = setInterval(
        () => this.#onSupervise(),
        this.#config.superviseIntervalSeconds! * 1000
      )
      this.#stopped = false
    }
  }

  async stop () {
    if (!this.#stopped) {
      this.#stopping = true
      if (this.#superviseInterval) clearInterval(this.#superviseInterval)
      this.#stopped = true
      while (this.#maintaining) {
        await delay(10)
      }
    }
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/boss.ts',
          lines: '90-113',
          text: `  async #executeQuery (query: plans.SqlQuery | string) {
    if (typeof (query) === 'string') {
      query = { text: query, values: [] }
    }

    const started = Date.now()

    const result = unwrapSQLResult(await this.#db.executeSql(query.text, query.values))

    const elapsed = (Date.now() - started) / 1000

    if (
      elapsed > this.#slowQuerySeconds ||
      this.#config.__test__warn_slow_query
    ) {
      await emitAndPersistWarning(this.#warningContext,
        WARNING_TYPES.SLOW_QUERY,
        WARNINGS.SLOW_QUERY.message,
        { elapsed, sql: query.text, values: query.values }
      )
    }

    return result
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/boss.ts',
          lines: '180-203',
          text: `    const queueGroups = queues.reduce<
      Record<string, { table: string; queues: types.Queue[] }>
    >((acc, q) => {
      const { table } = q
      acc[table] = acc[table] || { table, queues: [] }
      acc[table].queues.push(q)
      return acc
    }, {})

    for (const queueGroup of Object.values(queueGroups)) {
      if (this.#stopping) return

      const { table, queues } = queueGroup
      const names = queues.map((i) => i.name)

      while (names.length) {
        if (this.#stopping) return

        const chunk = names.splice(0, 100)

        await this.#monitor(table, chunk)
        await this.#maintain(table, chunk)
      }
    }`
        }
      ]
    },

    {
      id: 'expiry-retention',
      chapter: 'Background machinery',
      title: 'Expiry, heartbeats, and getting rid of rows',
      body: `
<p>A worker process can die mid-job. Nothing tells the database. Two supervisor queries recover
from that, and they answer two different questions.</p>

<h2>expire_seconds: "this took too long"</h2>
<p><code>failJobsByTimeout</code> fails any <code>active</code> job whose
<code>started_on + expire_seconds</code> is in the past. A blunt wall clock on the whole job. It
runs no matter what the handler is doing.</p>

<h2>heartbeat_seconds: "nobody is holding this any more"</h2>
<p><code>failJobsByHeartbeat</code> fails any active job whose <code>heartbeat_on</code> has gone
stale. This is opt-in per job and is the mechanism for long-running work: the worker's heartbeat
timer calls <code>touch()</code> on a cadence, and if the process dies the heartbeat stops and the
job is reclaimed in seconds rather than after the full expiry.</p>

<p>Both reuse <code>failJobs</code>, so a reclaimed job goes through the same retry, backoff and
dead-letter path as one that threw — only the <code>output</code> differs.</p>

<h2>There is no archive table</h2>
<div class="callout warn"><p>If you know older pg-boss, unlearn this: archiving was replaced in v12
with in-place retention. There is no <code>archive</code> table and nothing is moved. Jobs simply
stay where they are until they are deleted.</p></div>

<p>Two columns decide when that happens, and <code>deletion()</code> reads as exactly two rules:</p>
<ul>
  <li><strong>Finished jobs</strong> — <code>completed_on + deletion_seconds &lt; now()</code>.
  This is how long you can still query a job's outcome.</li>
  <li><strong>Never-run jobs</strong> — <code>state &lt; 'active' AND keep_until &lt; now()</code>.
  A job that was created and never picked up is garbage after its retention window, and
  <code>keep_until</code> was computed at insert time from <code>start_after</code>.</li>
</ul>

<h2>The string-integer trap</h2>
<p>Distributed backends return integer columns as <em>strings</em>. A bare <code>&gt;</code> then
compares lexicographically, and <code>"100" &gt; "9"</code> is false. The backlog warning was
silently never firing on CockroachDB until <code>Number()</code> was added. Any new numeric column
you compare needs the same treatment.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '1804-1823',
          text: `export function failJobsByTimeout (schema: string, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const where = \`state = '\${JOB_STATES.active}'
            AND (started_on + expire_seconds * interval '1s') < now()
            AND name = ANY(\${serializeArrayParam(queues)})\`

  const output = '\\'{ "value": { "message": "job timed out" } }\\'::jsonb'

  return locked(schema, failJobs(schema, table, where, output), table + 'failJobsByTimeout', noAdvisoryLocks)
}

export function failJobsByHeartbeat (schema: string, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const where = \`state = '\${JOB_STATES.active}'
            AND heartbeat_seconds IS NOT NULL
            AND (heartbeat_on + heartbeat_seconds * interval '1s') < now()
            AND name = ANY(\${serializeArrayParam(queues)})\`

  const output = '\\'{ "value": { "message": "job heartbeat timeout" } }\\'::jsonb'

  return locked(schema, failJobs(schema, table, where, output), table + 'failJobsByHeartbeat', noAdvisoryLocks)
}`,
          note: 'Same <code>failJobs</code> body as a thrown handler — only the WHERE and the recorded output change.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '2296-2309',
          text: `export function deletion (schema: string, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const sql = \`
    DELETE FROM \${schema}.\${table}
    WHERE name = ANY(\${serializeArrayParam(queues)})
      AND
      (
        (deletion_seconds > 0 AND completed_on + deletion_seconds * interval '1s' < now())
        OR
        (state < '\${JOB_STATES.active}' AND keep_until < now())
      )
  \`

  return locked(schema, sql, table + 'deletion', noAdvisoryLocks)
}`,
          note: 'The entire retention policy. <code>deletion_seconds = 0</code> means "keep forever".'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/boss.ts',
          lines: '236-239',
          text: `      // Coerce with Number(): CockroachDB returns these integer columns as strings, so a bare \`>\`
      // would compare lexicographically ("100" > "9" === false) and silently miss the backlog. On
      // standard Postgres these are already numbers, so Number() is a no-op.
      const warnings = rowsCacheStats.filter(i => Number(i.queuedCount) > (Number(i.warningQueueSize) || this.#largeQueueSize))`
        }
      ]
    },

    {
      id: 'timekeeper',
      chapter: 'Background machinery',
      title: 'timekeeper.ts: cron, and the clock problem',
      body: `
<p>Scheduling is implemented with the queue itself. There is an internal queue called
<code>__pgboss__send-it</code>, worked by an ordinary <code>manager.work()</code> call. The cron
tick does not send your job — it enqueues an instruction to send your job, and a normal worker
carries it out.</p>

<p>That indirection buys two things: the actual send inherits all the usual retry and error
handling, and a scheduling burst becomes one bulk <code>insert()</code> instead of N sends.</p>

<h2>Double protection against duplicates</h2>
<p>The cadence gate already means one instance per tick. But each scheduled job is <em>also</em>
inserted with <code>singletonKey: \`\${name}__\${key}\`</code> and
<code>singletonSeconds: 60</code>. Even if two instances somehow both pass the gate, the throttle
index collapses them into one job. Belt and braces, and cheap.</p>

<h2>Cron is evaluated against the database's clock</h2>
<p><code>shouldSendIt</code> parses the expression relative to
<code>Date.now() + this.clockSkew</code>, where <code>clockSkew</code> is measured periodically
against the server. Then it asks: <em>when was the previous firing, and was it less than 60 seconds
ago?</em></p>

<div class="callout warn"><p>That 60-second window is why the docs recommend 5-field cron over
6-field. A schedule of <code>30 30 3 * * *</code> only fires if a monitor tick lands inside its
window — and the monitor interval defaults to 30 seconds but is not guaranteed. Minute granularity
is the supported precision.</p></div>

<p>Clock skew larger than 60 seconds also raises a warning of its own, because at that point cron
evaluation is no longer trustworthy. If you are debugging "my schedule fires twice" or "never
fires", check the skew before you check the expression — a laptop running Docker in a VM is a
classic source of a few seconds' drift.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/timekeeper.ts',
          lines: '178-188',
          text: `  async cron () {
    const schedules = await this.getSchedules()

    const scheduled = schedules
      .filter(i => this.shouldSendIt(i.cron, i.timezone))
      .map(({ name, key, data, options }): types.JobInsert => ({ data: { name, data, options }, singletonKey: \`\${name}__\${key}\`, singletonSeconds: 60 }))

    if (scheduled.length > 0 && !this.stopped) {
      await this.manager.insert(QUEUES.SEND_IT, scheduled)
    }
  }`,
          note: 'The job\\u2019s <code>data</code> is the send request itself — name, data and options — replayed later by the send-it worker.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/timekeeper.ts',
          lines: '190-199',
          text: `  shouldSendIt (cron: string, tz: string) {
    const databaseTime = Date.now() + this.clockSkew

    const interval = CronExpressionParser.parse(cron, { tz, strict: false, currentDate: new Date(databaseTime) })

    const prevTime = interval.prev()

    const prevDiff = (databaseTime - prevTime.getTime()) / 1000

    return prevDiff < 60`
        }
      ]
    },

    {
      id: 'navigator',
      chapter: 'Background machinery',
      title: 'navigator.ts: keeping completion join-free',
      body: `
<p>This subsystem exists because of a performance bug, and the whole design is a response to it.</p>

<p>Unblocking a job's dependents used to happen inline inside <code>completeJobs</code>. That meant
completion joined <code>job_dependency</code> against the partitioned <code>job</code> table, and
its cost grew with the number of partitions — so adding queues made every completion slower
(issue #824). The fix was to take it off the hot path entirely.</p>

<h2>The audit, in four CTEs</h2>
<ol>
  <li><code>locked_parents</code> — completed jobs still marked <code>blocking</code>, found through
  the <code>job_i9</code> partial index, locked with <code>SKIP LOCKED</code> so several instances
  can audit different batches at once.</li>
  <li><code>decremented</code> — join <code>job_dependency</code> to count how many parents each
  child just lost.</li>
  <li><code>locked_children</code> + <code>unblocked</code> — subtract, and clear
  <code>blocked</code> for any child that reached zero.</li>
  <li><code>cleared</code> — set <code>blocking = false</code> on the parents. <strong>This is what
  makes it terminate</strong>: the parent immediately drops out of <code>job_i9</code>, so it is
  never audited again.</li>
</ol>

<div class="callout"><p><code>job_i9</code> is
<code>(name, id) WHERE blocking AND state = 'completed'</code>. For anyone not using flows, that
index is permanently empty — it costs nothing to have and nothing to scan. Designing the background
work so that it is free when unused is why this could be enabled by default.</p></div>

<h2>Guarding the invariant</h2>
<p>The regression is protected by a test that reads the generated SQL and asserts the
<code>completeJobs*</code> builders contain neither <code>job_dependency</code> nor
<code>FOR UPDATE</code>. If you are ever tempted to make completion do "just one more thing", that
test is the tripwire.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/navigator.ts',
          lines: '12-21',
          text: `// Cap audit batches per resolve pass so a large backlog can't monopolize the loop; whatever is
// left over is picked up on the next poll.
const MAX_BATCHES_PER_PASS = 100

// Background flow resolver. Completion is kept on a join-free hot path (see issue #824); the
// dependency bookkeeping that used to run inline now happens here, out of band. Modeled on the
// Bam poller: on each tick it claims the cluster-wide cadence gate (version.flow_on) and, if it
// wins, audits for completed "blocking" parents via the job_i9 partial index, decrements their
// children, unblocks those reaching zero, and clears the parents' blocking flag so they are not
// reprocessed. The Guild Navigator that keeps the spice flowing.`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '2156-2193',
          text: `export function resolveFlowJobs (schema: string, table: string, names: string[]): SqlQuery {
  return {
    text: \`
    WITH locked_parents AS (
      SELECT j.name, j.id
      FROM \${schema}.\${table} j
      WHERE j.blocking
        AND j.state = '\${JOB_STATES.completed}'
        AND j.name = ANY($1::text[])
      ORDER BY j.name, j.id
      FOR UPDATE OF j SKIP LOCKED
      LIMIT \${FLOW_BATCH_SIZE}
    ),
    decremented AS (
      SELECT d.child_name, d.child_id, COUNT(*)::int AS n
      FROM \${schema}.job_dependency d
      JOIN locked_parents p ON d.parent_name = p.name
        AND d.parent_id = p.id
      GROUP BY d.child_name, d.child_id
    ),
    \${lockedChildrenCte(schema)},
    unblocked AS (
      \${unblockChildrenUpdate(schema)}
      RETURNING 1
    ),
    cleared AS (
      UPDATE \${schema}.\${table} j
      SET blocking = false
      FROM locked_parents p
      WHERE j.name = p.name
        AND j.id = p.id
      RETURNING 1
    )
    SELECT COUNT(*)::int AS resolved FROM cleared
  \`,
    values: [names]
  }
}`,
          note: 'On CockroachDB this one statement becomes three, run inside a transaction — <code>noMultiMutationCte</code> again.'
        },
        { kind: 'svg', name: 'flow-dag' }
      ],
      quiz: {
        q: 'Ten application instances are running, each with its own supervisor, timekeeper and flow resolver. What stops all ten from doing the same maintenance work every tick?',
        options: [
          'A Postgres advisory lock held for the duration of the maintenance pass',
          'A conditional <code>UPDATE … RETURNING true</code> on a timestamp column, which only one instance can win per interval',
          'Leader election over LISTEN/NOTIFY',
          'Nothing — the work is idempotent, so duplication is harmless'
        ],
        answer: 1,
        explain: 'The <code>trySetTimestamp</code> gate. One statement, no held locks, no extra infrastructure: the winner is whoever\\u2019s UPDATE matched the interval predicate first, and everyone else gets zero rows and skips. Advisory locks <em>are</em> used, but for something different — serialising individual maintenance statements — and they are unavailable on several backends, which is exactly why the cadence gate cannot depend on them.'
      }
    },

    /* ================= Ch 6 · Connectivity ================= */

    {
      id: 'notifier',
      chapter: 'Connectivity',
      title: 'NOTIFY is only ever a latency hint',
      body: `
<p>96 lines, a quarter of them comments, and the most important sentence in the codebase sits at
the top of the file:</p>

<div class="callout"><p><strong>A NOTIFY is only ever a latency hint: it wakes workers so they run
their normal locking fetch sooner than the polling interval.</strong></p></div>

<p>Internalise that and a lot of questions answer themselves. A notification never carries a job.
It never claims anything. Losing one costs latency, not correctness — the worker will poll anyway.
That is why <code>useListenNotify</code> can default to off, why a failed listener is a
<code>warning</code> and not an error, and why the code has three separate degradation paths that
all end in "continue with polling only":</p>

<ol>
  <li>the backend has no LISTEN/NOTIFY at all (CockroachDB, Bun's SQL client)</li>
  <li>the supplied <code>IDatabase</code> does not implement the optional <code>listen</code></li>
  <li>establishing the listener threw (PgBouncer in transaction mode, a dropped connection)</li>
</ol>

<h2>The one-bit contract</h2>
<p><code>get available()</code> is true only while a listener handle exists. That single boolean is
what <code>resolveInterval</code> reads to choose between the relaxed notify interval and the
normal polling interval. Notifications get you a longer poll interval, not a different
architecture.</p>

<h2>Why the channel name is resolved with a query</h2>
<p><code>LISTEN</code> cannot take an expression, so the listener needs a literal channel name. The
producer inlines the same SQL expression in its <code>pg_notify</code> call. Rather than compute
the name twice in two languages, the notifier asks the database to evaluate the shared expression
once — so both sides are guaranteed to agree.</p>

<p>The two callbacks are the whole integration: a notification wakes the workers on that queue, and
a <em>reconnect</em> triggers <code>forceFetchLnWorkers()</code> — because anything published while
the listener was down was missed, and a blind fetch is the recovery.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/notifier.ts',
          lines: '13-16',
          text: `// Owns the LISTEN/NOTIFY listener lifecycle. A NOTIFY is only ever a latency hint: it
// wakes workers so they run their normal locking fetch sooner than the polling interval
// If the listener can't be established (custom adapter, PgBouncer transaction pooling,
// dropped connection), fall back to polling after emitting a warning.`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/notifier.ts',
          lines: '32-37',
          text: `  // True only once the listener handle is established. False before start(), when the
  // database doesn't support LISTEN or it fails (warning path), and after stop(). Workers
  // read this to decide between the relaxed notify polling interval and the fallback.
  get available (): boolean {
    return this.#handle !== null
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/notifier.ts',
          lines: '61-78',
          text: `    try {
      // Resolve the channel literal once from the shared SQL expression. LISTEN cannot take
      // an expression, so the listener needs the concrete name; the producer inlines the
      // same expression, so both sides always agree.
      const { rows } = await this.#db.executeSql(\`SELECT \${plans.notifyChannelSql(this.#config.schema)} AS channel\`)
      const channel = rows[0].channel

      this.#handle = await this.#db.listen(
        channel,
        payload => this.#manager.notifyQueue(payload),
        () => this.#manager.forceFetchLnWorkers()
      )
    } catch (err: any) {
      this.emit(events.warning, {
        message: 'Failed to start LISTEN/NOTIFY listener. Continuing with polling only.',
        data: { type: WARNING_TYPE, error: err?.message }
      })
    }`
        }
      ]
    },

    {
      id: 'idatabase',
      chapter: 'Connectivity',
      title: 'IDatabase, and the self-healing listener',
      body: `
<p>The extension point for the entire library is <strong>one required method</strong>. Implement
<code>executeSql</code> and pg-boss will run on your connection — your ORM's transaction, a
serverless proxy, an embedded database. <code>listen</code> is optional and only unlocks a latency
optimisation.</p>

<p><code>withTransaction</code> is worth reading for one detail: the object handed to your callback
is a <em>narrower</em> <code>IDatabase</code> exposing only <code>executeSql</code>, backed by the
pinned client. You cannot accidentally start a listener or a nested transaction on it.</p>

<h2>The listener is the most defensive code in the repo</h2>
<p>It uses a dedicated <code>pg.Client</code>, not a pooled connection, so it can never deplete the
query pool and so reconnection is self-contained. Then it handles three separate failure modes:</p>

<ul>
  <li><strong>Loud death</strong> — the client's <code>error</code> event, which reconnects with
  capped exponential backoff (1s doubling to a 30s ceiling).</li>
  <li><strong>Silent death</strong> — TCP keepalive, for a connection whose socket is gone but
  whose failure never surfaced.</li>
  <li><strong>Silent <em>subscription</em> loss</strong> — the interesting one. A heartbeat races a
  <code>pg_listening_channels()</code> query against a timeout. That catches a connection that is
  perfectly healthy but is no longer subscribed — which a socket-level check would never notice.</li>
</ul>

<div class="callout"><p>The <code>established</code> flag exists for a subtle reason spelled out in
the comment: if the <em>initial</em> connect fails, the rejection propagates to the notifier, which
falls back to polling and <strong>discards the handle</strong>. A reconnect scheduled from the error
handler would then be an untracked connection that nothing can close — keeping the event loop alive
and delivering notifications into a stopped manager. So self-healing is armed only after the first
success.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/types.ts',
          lines: '19-33',
          text: `export interface IDatabase {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  /**
   * Optional capability for LISTEN/NOTIFY support. When present, pg-boss can hold a
   * dedicated session-pinned connection to receive notifications. The built-in pool-based
   * Db implements this; custom adapters may implement it to enable \`useListenNotify\`.
   * Must invoke \`onReconnect\` after each successful (re)subscribe so missed notifications
   * can be recovered. Returns a handle whose \`close()\` tears down the listener.
   */
  listen?(channel: string, onNotification: (payload: string) => void, onReconnect: () => void): Promise<ListenHandle>;
}

export interface ListenHandle {
  close(): Promise<void>;
}`,
          note: 'The whole contract. Everything else in <code>db.ts</code> is an implementation detail of one particular implementation.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/db.ts',
          lines: '220-238',
          text: `  async withTransaction<T> (fn: (db: types.IDatabase) => Promise<T>): Promise<T> {
    assert(this.opened, 'Database not opened. Call open() before executing SQL.')

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const txDb: types.IDatabase = {
        executeSql: (text: string, values?: unknown[]) => client.query(text, values)
      }
      const result = await fn(txDb)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/db.ts',
          lines: '85-106',
          text: `    // Only self-heal once the listener has been established at least once. If the INITIAL connect
    // fails, the rejection propagates to the caller (Notifier.start), which falls back to
    // polling-only and discards this subscription's close handle — so a reconnect scheduled from
    // the client 'error' handler would be an untracked connection nothing can close, keeping the
    // event loop alive and delivering notifications into a stopped manager.
    let established = false

    const clearHeartbeat = () => {
      if (!heartbeatTimer) return
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return
      const backoff = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))
      attempt++
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect().catch(() => scheduleReconnect())
      }, backoff)
    }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/db.ts',
          lines: '127-157',
          text: `    const heartbeat = async (target: pg.Client) => {
      if (closed || client !== target) return

      let timeout: ReturnType<typeof setTimeout> | null = null
      const query = target.query(
        \`SELECT EXISTS (
           SELECT 1
             FROM pg_listening_channels() AS active(channel)
            WHERE channel = $1
         ) AS listening\`,
        [channel]
      )
      query.catch(() => {})

      try {
        const result = await Promise.race([
          query,
          new Promise<never>((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('LISTEN/NOTIFY heartbeat timed out')), heartbeatTimeout)
          })
        ])

        if (!result.rows[0]?.listening) {
          throw new Error('LISTEN/NOTIFY channel registration was lost')
        }
      } finally {
        if (timeout) clearTimeout(timeout)
      }

      scheduleHeartbeat(target)
    }`,
          note: 'Asking the session whether it is still subscribed, rather than whether the socket is still open.'
        }
      ]
    },

    {
      id: 'adapters',
      chapter: 'Connectivity',
      title: 'Adapters: where other drivers disagree with Postgres',
      body: `
<p>Two adapters ship in <code>src/adapters/</code>, and both are a masterclass in the same lesson:
<em>an adapter is not a thin wrapper, it is a list of documented disagreements.</em></p>

<h2>fromPglite — 66 lines, two problems</h2>
<p><strong>query vs exec.</strong> PGlite's <code>query()</code> runs a single statement, but
pg-boss issues concatenated multi-statement DDL with no parameters. Those must go through
<code>exec()</code>, whose per-statement results are flattened so a <code>RETURNING</code> in the
middle is not lost behind the trailing <code>COMMIT</code>.</p>
<p><strong>One connection.</strong> pg-boss assumes pool semantics: a failed statement must not
affect the next. PGlite has a single connection, so a failure inside a transaction poisons
everything after it. The adapter emulates a pool by issuing <code>ROLLBACK</code> before
rethrowing.</p>

<h2>fromBunSql — the one that replaces the pool</h2>
<p>It carries five distinct workarounds, each with a comment naming the Bun version it was verified
against:</p>
<ol>
  <li><strong>Transactions on a pooled connection are refused.</strong> Bun rejects
  <code>BEGIN</code> on a pooled handle, so any statement matching a deliberately broad
  <code>BEGIN</code> regex is retried on a reserved connection.</li>
  <li><strong>SQLSTATE arrives on the wrong property.</strong> Bun puts its own class on
  <code>code</code> and the real SQLSTATE on <code>errno</code>. Since pg-boss keys real behaviour
  on <code>23505</code> and <code>22012</code>, the adapter promotes the SQLSTATE onto
  <code>code</code>.</li>
  <li><strong>Aborted transactions leak across the pool</strong> (SQLSTATE <code>25P02</code>). Bun
  can hand out a connection in the window between a failed transaction and its rollback. Rather
  than prevent it, the adapter treats it as transient and retries.</li>
  <li><strong>JSON parameters get double-encoded.</strong> Bun stringifies json params, but pg-boss
  usually binds already-encoded text — so casts are rewritten to <code>$n::text::jsonb</code>.</li>
  <li><strong>Arrays are not bound as arrays.</strong> Bun joins elements with commas and no braces.
  The adapter builds the Postgres array literal by hand — which is what makes every
  <code>= ANY($n::uuid[])</code> in the codebase work.</li>
</ol>

<div class="callout warn"><p><code>CLAUDE.md</code> describes four of these; the file currently
carries five (the <code>25P02</code> retry is the extra one). When they disagree, the source wins.
<code>ISSUES.txt</code> at the repo root is the live log — read it before touching
<code>adapters/bun.ts</code>.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/adapters/pglite.ts',
          lines: '22-49',
          text: `  // pg-boss issues each statement expecting connection-pool semantics: an error on one statement
  // must not affect the next. PGlite has a single connection, so a failed statement inside a
  // BEGIN...COMMIT block (e.g. a migration that rolls back) leaves the connection in an aborted
  // transaction that poisons every later query. A pooled driver sidesteps this by handing out a
  // fresh connection; we emulate it by rolling back any aborted transaction before rethrowing.
  const run = async (text: string, values?: unknown[]) => {
    if (values?.length) {
      return await pglite.query(text, values)
    }

    // No parameters: may be a multi-statement block (e.g. a \`locked()\` BEGIN ... RETURNING ...
    // COMMIT). exec() returns one result per statement; flatten their rows so a RETURNING in the
    // middle isn't lost behind a trailing COMMIT. This mirrors how pg-boss unwraps the array that
    // node-postgres returns for multi-statement queries (see unwrapSQLResult).
    const results = await pglite.exec(text)
    return { rows: results.flatMap(r => r.rows ?? []) }
  }

  const db: IDatabase = {
    async executeSql (text: string, values?: unknown[]) {
      try {
        return await run(text, values)
      } catch (err) {
        await pglite.query('ROLLBACK').catch(() => {})
        throw err
      }
    }
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/adapters/bun.ts',
          lines: '43-64',
          text: `// Bun puts its own error class on \`code\` and the postgres SQLSTATE on \`errno\`, where every other
// driver pg-boss supports puts the SQLSTATE on \`code\`. pg-boss keys real behavior on it — a fetch
// tolerates 23505 from a queue policy's unique index rather than failing (manager.ts), and a job
// insert translates the 22012 its ON CONFLICT guard raises into an actionable message — so the
// SQLSTATE is promoted onto \`code\` and bun's class kept on \`bunCode\`.
const SERVER_ERROR = 'ERR_POSTGRES_SERVER_ERROR'

// Bun 1.3.x hands a pooled connection to a waiting query in the window between a transaction block
// failing and the ROLLBACK that clears its aborted state, so an unrelated query fails with 25P02.
// Reserving does not help — the leak is inside the pool the reserved connection came from. Rather
// than prevent it, treat the aborted transaction as transient and clear it on the way through.
const ABORTED_TRANSACTION = '25P02'
const ABORTED_RETRY_LIMIT = 3

function promoteSqlState (err: any): any {
  if (err?.code === SERVER_ERROR && typeof err.errno === 'string') {
    err.bunCode = err.code
    err.code = err.errno
  }

  return err
}`,
          note: 'Three lines of code, nineteen lines of explanation. That ratio is correct for an adapter.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/adapters/bun.ts',
          lines: '107-131',
          text: `// Bun serializes an array parameter by joining its elements with commas and no braces, which
// postgres rejects as a malformed array literal — so every \`= ANY($n::uuid[])\` and \`$n::text[]\`
// query pg-boss emits fails. Encode the array literal ourselves, the way node-postgres does; bun
// passes a string through untouched and the explicit ::type[] cast pg-boss always writes gives
// postgres the element type. A literal string keeps working if bun later binds arrays natively.
// Verified against bun 1.4.0.
function toArrayLiteral (values: readonly unknown[]): string {
  const elements = values.map(value => {
    if (value === null || value === undefined) {
      return 'NULL'
    }

    if (Array.isArray(value)) {
      return toArrayLiteral(value)
    }

    const text = value instanceof Date ? value.toISOString() : String(value)

    // Quoting every element keeps commas, braces and whitespace inside a value from being read as
    // array syntax; backslashes and double quotes then need escaping within the quotes.
    return \`"\${text.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"')}"\`
  })

  return \`{\${elements.join(',')}}\`
}`
        }
      ]
    },

    /* ================= Ch 7 · Schema evolution ================= */

    {
      id: 'contractor',
      chapter: 'Schema evolution',
      title: 'contractor.ts: install, migrate, or refuse',
      body: `
<p>The target schema version is a single integer in <code>package.json</code> under
<code>pgboss.schema</code> — currently <strong>37</strong>. <code>contractor.ts</code> reads it at
import time and compares it against the <code>version</code> table.</p>

<p><code>start()</code> is then a three-way decision: not installed → check for a case variant and
<code>create()</code>; installed but behind → <code>migrate()</code>; current → nothing. With
<code>migrate: false</code> the <code>check()</code> path throws instead, which is what you want in
a deployment where migrations are run by a separate release step.</p>

<h2>Two instances booting at once is expected</h2>
<p><code>create()</code> and <code>migrate()</code> both wrap the whole thing in a try/catch and
<code>assert</code> that the error is the <em>specific</em> race message. The loser of the race
swallows its own error and carries on; anything else rethrows. Note that the assertion is inverted
from the usual shape — it asserts the error <em>is</em> the tolerable one, so an unexpected error
fails the assert and surfaces with the original attached.</p>

<h2>The schema-case trap</h2>
<div class="callout warn"><p><code>schema: 'MySchema'</code> and <code>schema: '"MySchema"'</code>
are <strong>different schemas</strong>. Postgres folds the bare form to <code>myschema</code> and
stores the quoted one verbatim. The configs differ by two characters and look identical in logs.</p></div>

<p>What makes this vicious is that getting it wrong is not an error. The <code>version</code> table
simply is not there, so pg-boss cheerfully installs a second, empty schema beside the populated one
and every existing job appears to vanish. <code>assertNoSchemaCaseVariant</code> checks for that
case on the install path only, and only when the variant actually holds a pg-boss install — and it
tells you the exact spelling to use. It is escapable with
<code>allowSchemaCaseVariant: true</code>.</p>

<p>Note the empty <code>catch</code>: if the catalog probe itself cannot run (permissions, an
unusual backend), that is not evidence of a problem and must never block an install that would
otherwise succeed. A good instinct for any preflight check.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/contractor.ts',
          lines: '5-27',
          text: `import packageJson from '../package.json' with { type: 'json' }
import type * as types from './types.ts'

const schemaVersion = packageJson.pgboss.schema as number

// A name postgres would store unchanged if written without quotes.
const BARE_LOWER_IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]*$/

class Contractor {
  static constructionPlans (schema = plans.DEFAULT_SCHEMA, options = { createSchema: true }) {
    return plans.create(schema, schemaVersion, options)
  }

  static migrationPlans (schema = plans.DEFAULT_SCHEMA, version = schemaVersion - 1, options: { partitionTables?: string[] } = {}) {
    // Exported plans run without a BAM worker, so inline the async index builds as direct
    // DDL rather than job_table_run_async() enqueues (see issue #766). Callers that hold a
    // live connection can pass partitionTables to fan the builds out across partitions.
    return migrationStore.migrate(schema, version, undefined, undefined, { inlineAsync: true, partitionTables: options.partitionTables })
  }

  static rollbackPlans (schema = plans.DEFAULT_SCHEMA, version = schemaVersion) {
    return migrationStore.rollback(schema, version)
  }`,
          note: 'These three statics are what the CLI\\u2019s <code>plans</code> command and the exported <code>getConstructionPlans()</code> call.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/contractor.ts',
          lines: '64-90',
          text: `  // \`schema: 'MySchema'\` and \`schema: '"MySchema"'\` are two different schemas - postgres folds the
  // bare form to \`myschema\` and stores the quoted one verbatim - but the two configs differ by two
  // characters and are indistinguishable in logs. Getting it wrong is not an error on its own: the
  // version table simply isn't there, so pg-boss installs a second, empty schema alongside the
  // populated one and every existing job silently disappears. Fires only on the install path, and
  // only when the variant actually holds a pg-boss install, so an unrelated schema that happens to
  // share a folded name never blocks a legitimate install.
  private async assertNoSchemaCaseVariant () {
    if (this.config.allowSchemaCaseVariant) {
      return
    }

    const schema = this.config.schema
    let variants: string[]

    try {
      const result = await this.db.executeSql(plans.getSchemaCaseVariants(schema))
      variants = result.rows.map((r: { name: string }) => r.name)
    } catch {
      // Catalog access varies across backends and permission setups. A probe that cannot run is
      // not evidence of a problem, so it must never block an install that would otherwise succeed.
      return
    }

    if (variants.length === 0) {
      return
    }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/contractor.ts',
          lines: '220-236',
          text: `  async create () {
    try {
      const commands = plans.create(this.config.schema, schemaVersion, this.config)
      await this.db.executeSql(commands)
    } catch (err: any) {
      assert(err.message.includes(plans.CREATE_RACE_MESSAGE), err)
    }
  }

  async migrate (version: number) {
    try {
      const commands = migrationStore.migrate(this.config.schema, version, this.migrations, this.config.noAdvisoryLocks)
      await this.db.executeSql(commands)
    } catch (err: any) {
      assert(err.message.includes(plans.MIGRATE_RACE_MESSAGE), err)
    }
  }`,
          note: 'Tolerate exactly one error message; rethrow everything else, with the original error as the assert\\u2019s message.'
        }
      ]
    },

    {
      id: 'migration-store',
      chapter: 'Schema evolution',
      title: 'migrationStore.ts: authoring a migration',
      body: `
<p>One array holds the whole chain, versions 26 through 37. A migration is
<code>{ release, version, previous, install: string[], async?: string[], uninstall?: string[] }</code>,
and migrating means concatenating the <code>install</code> arrays of every migration whose
<code>previous</code> is at or above your current version, in one transaction.</p>

<h2>The race guard is a division by zero</h2>
<p><code>assertMigration</code> is prepended to every migration script and is, in full:</p>
<p><code>SELECT version::int/(version::int-37) FROM pgboss.version</code></p>
<p>If you are already at 37 the divisor is zero and Postgres raises SQLSTATE <code>22012</code>,
aborting the transaction. That is precisely the <code>MIGRATE_RACE_MESSAGE</code> the contractor
tolerates. The check is inside the same transaction as the migration, so it cannot be raced —
something a read-then-write in JavaScript could never guarantee.</p>

<h2>The version floor</h2>
<p>The selection is <code>filter(i =&gt; i.previous &gt;= version)</code>. Without a floor, any
version below the oldest <code>previous</code> selects the <em>entire</em> chain and applies
migrations over missing intermediate steps — at best a cryptic mid-transaction failure, at worst a
"success" that stamps the current version onto an incomplete schema. Hence the explicit assert, with
version 0 exempted as the "from scratch export" sentinel.</p>

<h2>Slow DDL takes two forms</h2>
<p>A migration's <code>async</code> array holds <code>job_table_run_async(...)</code> calls that
enqueue work for the BAM worker. But exported plans — printed by the CLI for a DBA to run — have no
BAM worker, so <code>inlineAsync</code> rewrites them back into direct DDL emitted after the
<code>COMMIT</code>.</p>

<div class="callout"><p>The file also keeps <strong>frozen historical copies</strong> of plpgsql
functions that later changed (<code>createQueueFn</code>, <code>jobTableFormatFn</code>), keyed by
version. A migration must reproduce the schema as it was at that version — so it can never call the
current builder in <code>plans.ts</code>. If you change a function's body, the old body has to be
frozen here.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '2566-2569',
          text: `export function assertMigration (schema: string, version: number) {
  // raises 'division by zero' if already on desired schema version
  return \`SELECT version::int/(version::int-\${version}) from \${schema}.version\`
}`,
          note: 'Four lines, and a genuinely race-free guard.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/migrationStore.ts',
          lines: '101-114',
          text: `  // Refuse to migrate from a real DB version older than the oldest migration can start from.
  // Without this floor, \`filter(i => i.previous >= version)\` happily selects the whole chain for any
  // version below the minimum \`previous\`, applying migrations over missing intermediate steps — a
  // cryptic mid-transaction failure, or worse a "success" that stamps the latest version onto an
  // incomplete schema. Version 0 is the sentinel for a full "from scratch" export (getMigrationPlans)
  // and is intentionally exempt.
  // Only floor a valid numeric version; a non-numeric/garbage version falls through to the
  // "Version X not found" assert below. Version 0 is the full-export sentinel and is exempt.
  if (Number.isInteger(version) && version !== 0) {
    const minPrevious = Math.min(...migrations.map(i => i.previous))
    assert(version >= minPrevious,
      \`Cannot migrate pg-boss schema from version \${version}: the oldest supported starting version is \${minPrevious}. \` +
      'Upgrade to a schema at or above that version using an older pg-boss release first.')
  }`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/migrationStore.ts',
          lines: '118-140',
          text: `  const result = migrations
    .filter(i => i.previous >= version!)
    .sort((a, b) => a.version - b.version)
    .reduce((acc, migration) => {
      acc.install = acc.install.concat(migration.install)

      if (migration.async) {
        if (options.inlineAsync) {
          // Bypass BAM: emit the real index DDL (run after COMMIT) instead of enqueuing it.
          for (const cmd of migration.async) {
            concurrent.push(...inlineAsyncCommand(schema, cmd, migration.version, options.partitionTables || []))
          }
        } else {
          const bamCommands = migration.async.map(cmd =>
            cmd.replace(/\\$VERSION\\$/g, String(migration.version))
          )
          acc.install = acc.install.concat(bamCommands)
        }
      }

      acc.version = migration.version
      return acc
    }, { install: [] as string[], version })`
        }
      ]
    },

    {
      id: 'bam',
      chapter: 'Schema evolution',
      title: 'bam.ts: slow DDL, off the startup path',
      body: `
<p>BAM is "build a migration". Its reason to exist: <code>CREATE INDEX CONCURRENTLY</code> cannot
run inside a transaction, and on a large <code>job</code> table it can take hours. Blocking
<code>start()</code> on that is unacceptable, so the migration <em>enqueues</em> the command into
the <code>bam</code> table and a background poller applies it later.</p>

<h2>Ordering matters, so it uses clock_timestamp()</h2>
<p><code>bam.created_on</code> defaults to <code>clock_timestamp()</code>, not <code>now()</code>.
<code>now()</code> is fixed for the whole transaction, so a migration that drops an index and
rebuilds it would produce two rows with identical timestamps and an undefined order. That would be
a very bad day.</p>

<h2>A poison command must not starve the queue</h2>
<p>The claim query orders by <code>(status != 'pending'), created_on</code> — every pending command
is processed before any previously failed one is retried. A command that fails forever therefore
delays only itself.</p>

<h2>Liveness detection, and why it is not the obvious view</h2>
<p>To reclaim a command whose worker died, BAM must distinguish "still building" from "abandoned".
The obvious tool is <code>pg_stat_progress_create_index</code>. The code deliberately uses
<code>pg_locks</code> instead, and the comment explaining why is one of the most valuable things in
this repository:</p>

<div class="callout warn"><p><code>pg_stat_progress_*</code> is filtered to the querying role's
<strong>own</strong> backends. If two pg-boss instances connect under different roles, one would read
the other's live build as dead — and the heal step would then <code>DROP INDEX CONCURRENTLY</code> a
live index mid-build. <code>pg_locks</code> is cluster-wide and visible to every role, and
<code>CREATE INDEX CONCURRENTLY</code> holds a <code>ShareUpdateExclusiveLock</code> on the target
table for the entire build, releasing it the instant the backend dies. A crash-safe, role-agnostic
"build in flight" signal.</p></div>

<p>Note the direction of the residual false positive: an autovacuum on the same table also takes
that lock and reads as "live", which only <em>defers</em> a reclaim. Safe.</p>

<h2>Healing only drops invalid indexes</h2>
<p>A re-attempt might follow a build that actually <em>succeeded</em> but whose row was never marked
complete (a graceful stop landing between the two). That index is valid and in use. So the heal step
probes <code>indisvalid</code> first and only drops an index the previous attempt left broken.</p>
`,
      panels: [
        { kind: 'svg', name: 'bam-timeline' },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '2705-2712',
          text: `  // Native-Postgres liveness path. An in_progress row counts as "stale" (reclaimable) when it is past
  // the grace window AND no backend is actually building its index right now. The same predicate,
  // negated, defines a genuinely-live command that must still block the queue — so a running build is
  // NEVER reclaimed (no matter how long it runs), and a dead one recovers within the grace window.
  // There is deliberately no 24h absolute cap here: liveBuild=true always means a build is in flight, so
  // capping on elapsed time would reclaim a genuinely-running build and start a second
  // CREATE INDEX CONCURRENTLY on the same index — the exact double-build this path exists to prevent.
  // (The timeout-only path's BAM_STALE_SECONDS fallback covers engines with no way to detect liveness.)`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '2714-2724',
          text: `  // liveBuild(tableCol): is a CREATE INDEX CONCURRENTLY actively building this table's index right now?
  // Detected via pg_locks, NOT pg_stat_progress_create_index — and that choice is load-bearing for
  // multi-instance safety. pg_stat_progress_* is filtered to the querying role's OWN backends (only a
  // superuser or a member of pg_read_all_stats sees another role's builds), so a progress-view check
  // silently reads a peer's live build as "dead" whenever pg-boss instances connect under different DB
  // roles — and the heal step (bamHealProbe/bamHealDrop in bam.ts) would then DROP INDEX CONCURRENTLY a
  // live index mid-build, racing the builder into a double CREATE. pg_locks, by contrast, is cluster-wide
  // and visible to every role (verified empirically). CREATE INDEX CONCURRENTLY holds a
  // ShareUpdateExclusiveLock on the target table for the ENTIRE build and releases it the instant the
  // statement finishes or the backend dies, so a granted SUExclusive lock on the row's table is a
  // crash-safe, role-agnostic "build in flight" signal — instances may run under different roles with no`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/bam.ts',
          lines: '110-125',
          text: `      if (entry.reattempt && !this.#config.noIndexProgressView) {
        const dropSql = plans.bamHealDrop(this.#config.schema, entry.command)
        if (dropSql) {
          // Only heal an index the previous attempt left INVALID. A re-attempt can also fire for a
          // build that actually SUCCEEDED but whose row was never marked completed (a graceful stop
          // landed between the CREATE and markCompleted) — that index is VALID and in use, so dropping
          // it would tear down a live production index for the whole rebuild window. Probe indisvalid
          // first; skip the drop for a valid (or absent) index and let the command's IF NOT EXISTS re-run
          // no-op it and mark the row done.
          const probeSql = plans.bamHealProbe(this.#config.schema, entry.command)
          const { rows } = await this.#db.executeSql(probeSql!)
          if (rows[0]?.invalid) {
            await this.#db.executeSql(dropSql)
          }
        }
      }`
        }
      ]
    },

    {
      id: 'manifest-drift',
      chapter: 'Schema evolution',
      title: 'The generated manifest, and drift detection',
      body: `
<p><code>src/schema.json</code> is a catalog-introspected snapshot of a freshly created schema — in
both the partitioned and non-partitioned shapes. It is a <strong>generated artifact</strong>.</p>

<div class="callout warn"><p><strong>Never hand-edit <code>schema.json</code>.</strong> After any
DDL change in <code>plans.ts</code>, run <code>bun run gen:manifest</code>.
<code>gen:manifest:check</code> is wired into <code>pretest</code>, so forgetting is a red build
rather than silent drift.</p></div>

<h2>How it is generated</h2>
<p><code>scripts/gen-manifest.ts</code> spins up an in-process PGlite — a WASM Postgres, so no
server is needed — runs <code>plans.create(...)</code> on it, and introspects the result using
<strong>the exact same <code>drifter.getSchema*</code> queries the runtime drift check uses</strong>.
That reuse is the structural guarantee: the manifest and the live scan cannot diverge in how they
observe a schema, only in what they observe.</p>

<p>Two details make the output deterministic: the throwaway schema name is templated back to
<code>{{schema}}</code> so the manifest is schema-name agnostic, and dynamically named partitions
(<code>queue_stats_YYYYMMDD</code>) are dropped since their names depend on the calendar.</p>

<h2>drifter.ts knows nothing about pg-boss</h2>
<p>It is a generic diff engine: catalog probes on one side, normalisers and comparators on the other.
Nothing in it mentions a job or a queue. The bridge is in <code>plans.ts</code>, which reads
<code>schema.json</code> and produces the <code>expected*</code> inputs.</p>

<p>The one piece of hand-maintained knowledge is which policy indexes a given partition should have
— because that depends on the queue's policy and cannot be read from a static manifest. If you add
a policy, that table must be updated alongside the index builder and the <code>ELSIF</code> ladder in
<code>create_queue</code>.</p>

<div class="callout"><p><code>contractor.detectDrift()</code> wraps each catalog probe in its own
try/catch, and tracks "this probe is unsupported" separately from "this probe returned nothing" —
because feeding an empty live set into the comparator would report every object as missing and flip
the whole report to failed on backends that simply do not expose that catalog.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'scripts/gen-manifest.ts',
          lines: '1-11',
          text: `// Generates src/schema.json: the canonical, catalog-introspected shape of a freshly created
// pg-boss schema, for both the partitioned and non-partitioned architectures. The drift check compares
// the live database against this manifest, so the CREATE TABLE/FUNCTION/INDEX DDL in plans.ts is the
// single source of truth — the manifest is a generated artifact, never hand-edited.
//
// It runs entirely in-process on pglite (a WASM Postgres), so no external database is needed. The same
// drifter.getSchema* introspection queries the runtime drift check uses are reused here, which keeps
// the manifest and the live scan structurally identical by construction.
//
// Regenerate with \`npm run gen:manifest\`. CI verifies it is up to date via \`git diff --exit-code\`, so a
// DDL change that forgets to regenerate is a red build rather than silent drift.`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'scripts/gen-manifest.ts',
          lines: '21-39',
          text: `// A distinctive schema name so templating it back out to a placeholder can't collide with anything the
// catalog legitimately emits (type names, column literals, etc.).
const GEN_SCHEMA = '__pgboss_manifest__'
const SCHEMA_TOKEN = '{{schema}}'
const version = packageJson.pgboss.schema as number

const q = async (pg: PGlite, sql: string): Promise<any[]> => (await pg.query(sql)).rows

// Replaces the throwaway generation schema name with a placeholder everywhere it appears in
// catalog-emitted text (pg_get_constraintdef / pg_get_indexdef / pg_get_functiondef embed it, as do
// enum-typed column types and defaults), so the manifest is schema-name agnostic.
function templateSchema<T> (value: T): T {
  return JSON.parse(JSON.stringify(value).split(GEN_SCHEMA).join(SCHEMA_TOKEN))
}

// The queue_stats range partitions are provisioned per calendar day (queue_stats_YYYYMMDD), so their
// names are non-deterministic and must not enter the manifest — same treatment the drift check gives
// dynamic per-queue job partitions. They inherit the parent's shape, so nothing is lost.
const isDynamicPartition = (table: string) => /^queue_stats_\\d+$/.test(table)`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/plans.ts',
          lines: '2892-2905',
          text: `// job_iN partial indexes that gate on a queue policy: a per-queue partition table (partition:true)
// only receives the index for its own policy (see create_queue, createQueueFunction). The shared
// job_common table and a non-partitioned job table carry all of them at once. Keep in sync with the
// createIndexJobPolicy* builders and the ELSIF ladder in createQueueFunction.
const POLICY_JOB_INDEXES: Record<number, string> = {
  1: QUEUE_POLICIES.short,
  2: QUEUE_POLICIES.singleton,
  3: QUEUE_POLICIES.stately,
  6: QUEUE_POLICIES.exclusive,
  8: QUEUE_POLICIES.key_strict_fifo
}
// job_iN indexes with no policy gate — created on every job table regardless of policy
// (throttle i4, fetch i5, group-concurrency i7, blocking i9).
const BASE_JOB_INDEXES = [4, 5, 7, 9]`,
          note: 'The only hand-maintained knowledge in the drift path — and the comment names all three places to keep in sync.'
        }
      ],
      quiz: {
        q: 'You add a column to the <code>queue</code> table in <code>plans.ts</code> and write a migration. You run <code>bun run test</code> and it fails immediately, before any test executes. What is the most likely cause?',
        options: [
          'The migration transaction deadlocked with the test suite',
          '<code>gen:manifest:check</code> in the <code>pretest</code> hook found <code>schema.json</code> stale — run <code>bun run gen:manifest</code>',
          'You forgot to add the column to <code>drifter.ts</code>',
          'The new column needs an entry in <code>schema.json</code>, which you must edit by hand'
        ],
        answer: 1,
        explain: 'The <code>pretest</code> hook runs <code>tsc --noEmit</code> and <code>gen:manifest:check</code> before vitest starts, so a stale manifest fails the command with an error unrelated to any test. Regenerate it with <code>bun run gen:manifest</code> and commit the result. <code>drifter.ts</code> needs no change — it is generic — and <code>schema.json</code> is never hand-edited.'
      }
    },

    /* ================= Ch 8 · Working in this repo ================= */

    {
      id: 'compat-checklist',
      chapter: 'Working in this repo',
      title: 'The compatibility checklist',
      body: `
<p>Every query you write or change needs to survive four other database engines. Run this list.</p>

<h2>1. Does it mutate more than once in a statement?</h2>
<p>CockroachDB allows one mutation per statement. Any multi-CTE writer needs a split twin under
<code>noMultiMutationCte</code>, run inside a transaction by the manager. The supervisor shows the
pattern: two branches, one builder, one manager method.</p>

<h2>2. Does it lock?</h2>
<p><code>FOR UPDATE ... SKIP LOCKED</code> needs a <code>noSkipLocked</code> alternative — usually
an atomic <code>UPDATE</code> with a state recheck. <code>pg_advisory_xact_lock</code> needs a
<code>noAdvisoryLocks</code> path; look at how <code>locked()</code> takes that flag.</p>

<h2>3. Does it assume partitioning?</h2>
<p>Under <code>noTablePartitioning</code> there is no <code>job_common</code>, no per-queue tables,
and the three <code>job_table_*</code> plpgsql helpers do not exist at all.</p>

<h2>4. Does it compare a number?</h2>
<div class="callout warn"><p>Distributed backends return integer columns as <strong>strings</strong>.
A bare <code>&gt;</code> compares lexicographically, so <code>"100" &gt; "9"</code> is
<code>false</code>. Coerce with <code>Number()</code> — as <code>manager.ts</code>,
<code>boss.ts</code> and <code>navigator.ts</code> all do. This is the bug most likely to escape
review, because it is silently wrong rather than broken.</p></div>

<h2>5. Did you change DDL?</h2>
<p>Then <code>bun run gen:manifest</code>, add a migration, and bump
<code>package.json → pgboss.schema</code>.</p>

<h2>6. Run the matrix</h2>
<p><code>bun run test</code>, then <code>bun run test:distributed</code> (cheap, catches 1, 2 and 4),
then <code>bun run test:bun</code> and <code>bun run test:pglite</code>. The real distributed engines
have their own compose files when you need them.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'src/boss.ts',
          lines: '249-256',
          text: `      // CockroachDB rejects the multi-mutation failJobs() CTE these use, so under noMultiMutationCte
      // route expiry through the manager's split select/delete/re-insert variants instead.
      if (this.#config.noMultiMutationCte) {
        await this.#manager.failJobsByTimeoutDistributed(table, queues)
      } else {
        const sql = plans.failJobsByTimeout(this.#config.schema, table, queues, this.#config.noAdvisoryLocks)
        await this.#executeQuery(sql)
      }`,
          note: 'The canonical shape: branch at the call site, not inside the builder.'
        },
        {
          kind: 'code',
          lang: 'plain',
          label: 'the flags, and who sets them',
          text: `flag                      postgres  cockroachdb  yugabytedb  citus  pglite
────────────────────────  ────────  ───────────  ──────────  ─────  ──────
noSkipLocked                             x
noMultiMutationCte                       x
noTablePartitioning                      x            x
noDeferrableConstraints                  x
noAdvisoryLocks                          x            x
noCoveringIndexes                        x
noListenNotify                           x
noIndexProgressView                      x            x

Derived in attorney.resolveBackend from the "backend" option.
Never user-settable. Forced individually by the __test__* hooks.`
        }
      ]
    },

    {
      id: 'testing',
      chapter: 'Working in this repo',
      title: 'Test conventions you have to know',
      body: `
<p>The suite has one unusual mechanism, and everything else follows from it.</p>

<h2>Every test gets its own schema, derived from its name</h2>
<p><code>beforeEach</code> computes <code>pgboss + sha1(testFile + testName)</code> and uses it as
the Postgres schema. Tests are therefore fully isolated and can run in parallel against one
database. <strong>That schema also doubles as the queue name</strong> — <code>ctx.schema</code> is
both, which is why almost every test reads <code>ctx.boss.send(ctx.schema, …)</code>.</p>

<div class="callout warn"><p><strong>Leaf test names must be unique within a file.</strong> Two
tests with the same name in the same file get the same schema <em>and</em> the same queue, which
surfaces as flaky cross-test interference rather than a clean failure. A
<code>globalSetup</code> statically scans for duplicates and refuses to start the suite.</p></div>

<h2>Two things that will surprise you</h2>
<ul>
  <li><strong>A failing test leaves its schema behind</strong> — deliberately, so you can inspect
  it. Passing tests clean up. Expect stray schemas after a bad run.</li>
  <li><strong><code>supervise: false</code> is the default in tests.</strong> So is
  <code>schedule: false</code>. Any test of supervisor, navigator or timekeeper behaviour must opt
  back in, or call the ungated twin (<code>boss.supervise()</code>,
  <code>boss.resolveFlow()</code>) directly.</li>
</ul>

<h2>Use the skip helpers, not raw <code>it</code></h2>
<p>When a test depends on backend specifics, wrap it: <code>itPostgresOnly</code> for partitioning
and exact schema shape, <code>itPglite</code> when a real server or a second connection is needed,
<code>itDefaultDriver</code> when reaching into the built-in pool, <code>itListenNotify</code> for
notification behaviour. The <code>as TestAPI</code> casts are deliberate — they dodge a TypeScript
error about vitest's unnameable internal types.</p>

<h2>Test error paths with the <code>__test__*</code> hooks</h2>
<p>Before inventing a mocking strategy, grep <code>__test__</code> in <code>src/types.ts</code>.
There is very likely already a config hook that forces the failure you want —
<code>__test__throw_flow</code>, <code>__test__delay_bam_ms</code>,
<code>__test__force_clock_skew_warning</code>, <code>__test__distributed</code> and a dozen more.</p>
`,
      panels: [
        {
          kind: 'code',
          lang: 'ts',
          file: 'test/hooks.ts',
          lines: '40-58',
          text: `beforeEach(async (context) => {
  // Use vitest's task info for unique schema generation
  const testFile = context.task.file?.name || 'unknown'
  const testName = context.task.name || 'unknown'
  currentTestFile = testFile
  currentTestName = testName

  const testKey = getTestKey()
  const schema = \`pgboss\${sha1(testKey)}\`

  const config = helper.getConfig({ schema })
  assertTruthy(config.schema)
  console.log(\`      \${testName} (schema: \${config.schema})...\`)
  await helper.dropSchema(config.schema)

  ctx.bossConfig = config as ConstructorOptions & { schema: string }
  ctx.schema = config.schema
  ctx.boss = undefined
})`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'test/checkDuplicateTestNames.ts',
          lines: '5-16',
          text: `// Preflight guard run once before the suite (wired as vitest \`globalSetup\`).
//
// Each test derives its own Postgres schema from sha1(testFile + testName) (see hooks.ts), and the
// schema doubles as the queue namespace. Two tests in the same file with the same name therefore
// collide on a single schema + queue set. They run sequentially in one shared backend (notably the
// single in-memory PGlite instance under DB_TYPE=pglite), so the collision surfaces as flaky
// cross-test interference rather than a clean failure. Reject duplicate leaf test names per file up
// front so the mistake is caught immediately instead of as an intermittent CI failure.
//
// Names only need to be unique within a file (the file path is part of the schema key), so this
// scans each test file independently. It is a static scan of \`it(...)\`/\`test(...)\` string-literal
// titles; dynamically constructed names (template interpolation, .each) are out of scope.`
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'test/delayTest.ts',
          lines: '1-23',
          text: `import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('delayed jobs', function () {
  it('should wait until after an int (in seconds)', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const startAfter = 2

    await ctx.boss.send(ctx.schema, null, { startAfter })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()

    await delay(startAfter * 1000)

    const [job2] = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })`,
          note: 'The canonical shape. <code>describe</code>/<code>it</code> are globals; assigning <code>ctx.boss</code> is required or <code>afterEach</code> cannot stop the instance.'
        },
        {
          kind: 'code',
          lang: 'ts',
          file: 'test/testHelper.ts',
          lines: '82-93',
          text: `// PGlite has no server, so tests that connect by connection string (CLI subprocess, ORM adapters)
// or that require multiple independent connections cannot run against it. Wrap them with these.
const itPglite = it.skipIf(isPglite) as TestAPI
const describePglite = describe.skipIf(isPglite) as SuiteAPI

// Tests that need multiple independent role connections (e.g. one session holds a lock while
// another polls) can't run on PGlite (single in-process instance, no network) or CockroachDB.
const describeMultiConnectionOnly = describe.skipIf(isPglite || isCockroachDb) as SuiteAPI

// Tests that reach into the built-in pg pool (its size, its events) rather than going through
// IDatabase. Every mode that supplies its own \`db\` bypasses that pool entirely, so skip them there.
const itDefaultDriver = it.skipIf(isPglite || isBun) as TestAPI`
        }
      ]
    },

    {
      id: 'first-change',
      chapter: 'Working in this repo',
      title: 'Your first change',
      body: `
<p>You now know the shape of the thing. Here is the loop for changing it, in the order that avoids
rework.</p>

<h2>The house rules</h2>
<ul>
  <li><strong>All SQL goes in <code>plans.ts</code>.</strong> No exceptions, no inline strings in
  components.</li>
  <li><strong>All validation goes in <code>attorney.ts</code>.</strong> Not in
  <code>manager.ts</code>, and definitely not in <code>plans.ts</code>.</li>
  <li><strong>Comments are rare, one sentence, and explain WHY.</strong> Never what the code does —
  that is readable. The long comment blocks you have seen in this tutorial are the exception,
  earned by decisions that would otherwise be silently undone.</li>
  <li><strong>Lint is <code>neostandard</code>.</strong> No semicolons, space before parens,
  two-space indent. <code>bun run lint:fix</code> handles it, and <code>bun run test</code> runs
  <code>eslint .</code> first, so a lint error blocks the whole suite.</li>
</ul>

<h2>Where to start reading for a given task</h2>
<table>
  <tr><th>You want to change…</th><th>Start at</th></tr>
  <tr><td>How a job is claimed</td><td><code>plans.fetchNextJob</code>, then <code>manager.fetch</code></td></tr>
  <tr><td>Retry or dead-letter behaviour</td><td><code>plans.failJobsBody</code></td></tr>
  <tr><td>A new job or queue option</td><td><code>types.ts</code> → <code>attorney.ts</code> → <code>plans.insertJobs</code></td></tr>
  <tr><td>Polling behaviour</td><td><code>manager.work</code>'s <code>resolveInterval</code>, then <code>worker.ts</code></td></tr>
  <tr><td>Anything periodic</td><td><code>boss.ts</code>, and the <code>trySetTimestamp</code> gate</td></tr>
  <tr><td>A new table or column</td><td><code>plans.ts</code> DDL → <code>migrationStore.ts</code> → <code>gen:manifest</code></td></tr>
</table>

<div class="callout"><p>One last habit worth forming: when a query surprises you, read its
<em>index</em>. In this codebase the index predicate and the query predicate are written to match
term for term, and half the design decisions are visible only from that pairing.</p></div>
`,
      panels: [
        {
          kind: 'code',
          lang: 'plain',
          label: 'a schema-changing change, end to end',
          text: `1.  edit src/plans.ts
      the DDL builder, plus every query that touches the new shape
      check: does it need a distributed variant?

2.  add a migration in src/migrationStore.ts
      install:  the ALTER/CREATE, in order
      async:    anything using CONCURRENTLY (goes through BAM)
      uninstall: the rollback
      freeze a copy of any plpgsql function whose body you changed

3.  bump package.json -> pgboss.schema

4.  bun run gen:manifest
      regenerates src/schema.json — commit it

5.  bun run test
      pretest runs tsc + gen:manifest:check first
      eslint . runs before vitest

6.  bun run test:distributed
      cheapest way to catch multi-mutation CTEs, SKIP LOCKED
      assumptions, and string-integer comparisons

7.  bun run test:bun && bun run test:pglite`
        },
        {
          kind: 'code',
          lang: 'plain',
          label: 'the gotcha list, one line each',
          text: `schema.json is generated            never hand-edit it
integers come back as strings       Number() before comparing
policies live in indexes            read the WHERE clause, not the docs
enum order is semantic              state < 'active' is a real predicate
NOTIFY is a hint                    never required for correctness
completion must stay join-free      there is a test guarding this
supervise: false in tests           opt in, or call the ungated twin
test names unique per file          same name = same schema = flake
'MySchema' != '"MySchema"'          two schemas, two characters apart
ISSUES.txt before adapters/bun.ts   it is the live known-issues log`
        }
      ],
      quiz: {
        q: 'You are adding a <code>maxConcurrentPerTenant</code> option to <code>send()</code>. Which files does it touch, in which order?',
        options: [
          '<code>manager.ts</code> only — it is a runtime concern',
          '<code>types.ts</code> for the type, <code>attorney.ts</code> to validate and normalise it, then <code>plans.ts</code> for the column list and query — plus a migration and <code>gen:manifest</code> if it needs storage',
          '<code>plans.ts</code> only — all behaviour is SQL',
          '<code>schema.json</code> first, so the manifest is ready for the DDL'
        ],
        answer: 1,
        explain: 'Types describe it, <code>attorney.ts</code> validates it (validation never lives deeper), <code>plans.ts</code> implements it, and any storage means a migration, a <code>pgboss.schema</code> bump, and a regenerated manifest. <code>manager.ts</code> usually needs only to thread the value through. And <code>schema.json</code> is never written by hand — it is generated from the DDL, so it comes last.'
      }
    }

    /* SLIDES-CONTINUE */
  ]
})(window)
