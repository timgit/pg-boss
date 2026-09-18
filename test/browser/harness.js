// Real-browser verification for the PGliteWorker leader-change fix on `clock-followups`
// (commit d76a14e). The node tests drive the same seams against a worker-shaped fake; this drives
// them against real leader election, which needs navigator.locks and real Workers.
//
// No multiple tabs required: navigator.locks is origin-scoped and shared across dedicated workers,
// so several PGliteWorker instances in this one page contend for the same election lock. Closing
// the leader's instance terminates its worker, releases the lock, and promotes the next one.

/* global Worker, document, window, setTimeout, clearTimeout, console */

import { PGliteWorker } from '@electric-sql/pglite/worker'
import { fromPglite } from '/src/adapters/pglite.ts'

const SET_CLOCK = "SET pgboss.test_clock = 'on'"
const READ_CLOCK = "SELECT current_setting('pgboss.test_clock', true) AS v"
const LEADER_CHANGED = 'Leader changed, pending operation in indeterminate state'

// Every await here is bounded. A stranded reapply — an rpc posted to a tab channel the new leader
// has not attached to yet — would otherwise hang the page instead of reporting, and that is one of
// the things only a real run can show.
const TIMEOUT_MS = 15000

const out = document.getElementById('out')
const results = []

function log (line, cls = '') {
  const el = document.createElement('div')
  el.className = cls
  el.textContent = line
  out.appendChild(el)
  console.log(line)
}

function check (name, actual, expected) {
  const ok = Object.is(actual, expected)
  results.push({ name, ok, actual, expected })
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        actual:   ${JSON.stringify(actual)}\n        expected: ${JSON.stringify(expected)}`, ok ? 'pass' : 'fail')
}

// Settle-or-hang, for the upstream behaviour below. Never rejects.
function outcomeOf (promise, ms) {
  let timer
  const hung = new Promise(resolve => { timer = setTimeout(() => resolve('HUNG'), ms) })
  return Promise.race([
    promise.then(() => 'RESOLVED', err => err.message),
    hung
  ]).finally(() => clearTimeout(timer))
}

function withTimeout (promise, label) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${TIMEOUT_MS}ms: ${label}`)), TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// A unique id per run, so a reload does not inherit the previous run's election lock or leader.
function makeInstance (id, dataDir) {
  return PGliteWorker.create(
    new Worker(new URL('./pglite-worker.js', import.meta.url), { type: 'module' }),
    { id, dataDir }
  )
}

// PGliteLike is structural, so a plain wrapper is enough to record every statement the adapter
// issues — which is how the "no ROLLBACK after a leader change" claim gets checked.
function spy (instance) {
  const calls = []
  return {
    calls,
    instance,
    query: (text, params) => { calls.push(text); return instance.query(text, params) },
    exec: text => { calls.push(text); return instance.exec(text) },
    onLeaderChange: cb => instance.onLeaderChange(cb)
  }
}

const readClock = async db => (await db.executeSql(READ_CLOCK)).rows[0].v

// Leadership is never settled when a call returns. create() resolves on the worker's `ready`
// message; isLeader is set later, when the winning worker posts `leader-now`. And after a close()
// the lock has to be released, the next worker has to build a PGlite and broadcast, and followers
// re-register on a 16ms retry loop. So every leadership assertion waits first.
async function waitForLeader (instances, label) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (instances.some(i => i.isLeader)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`TIMEOUT: no leader elected (${label})`)
}

// An adapter from before this work has no session-statement concept at all. Rather than fail on a
// missing method, apply the SET the way the old code left callers to - straight onto the instance,
// once - so that checking out an older adapter reproduces the defect instead of erroring. That is
// the whole of it: nothing replays the SET when the leader changes.
let controlMode = false

async function applyClockStatement (db, instance) {
  if (typeof db.setSessionStatements === 'function') {
    await withTimeout(db.setSessionStatements([SET_CLOCK]), 'setSessionStatements')
    return
  }

  if (!controlMode) {
    controlMode = true
    log('PRE-FIX ADAPTER: no setSessionStatements(), so this checkout predates the leader-change\n        work. The survival checks below are expected to FAIL - that is the defect.', 'fail')
  }

  await withTimeout(instance.exec(SET_CLOCK), 'control SET')
}

async function scenarioPromotedInstance () {
  log('\n--- 1. the instance that BECOMES leader reapplies its session statements ---')
  const id = `harness-promoted-${Date.now()}`
  const a = await makeInstance(id, 'memory://')
  const b = await makeInstance(id, 'memory://')

  await waitForLeader([a, b], 'initial')
  check('a is the elected leader', a.isLeader, true)
  check('b starts as a follower', b.isLeader, false)

  const spied = spy(b)
  const db = fromPglite(spied)
  await applyClockStatement(db, b)
  check('clock setting is on before the leader change', await withTimeout(readClock(db), 'read before'), 'on')

  await a.close()
  await waitForLeader([b], 'promoted')
  check('b was promoted to leader', b.isLeader, true)

  // The whole point of the fix: b's worker built a brand new PGlite, so this is a session that
  // never saw the SET unless the adapter reapplied it from onLeaderChange.
  check('clock setting survives the leader change', await withTimeout(readClock(db), 'read after'), 'on')

  await b.close()
}

async function scenarioFollowerOfNewLeader () {
  log('\n--- 2. a FOLLOWER of the new leader reapplies (leader-here path) ---')
  const id = `harness-follower-${Date.now()}`
  const a = await makeInstance(id, 'memory://')
  const b = await makeInstance(id, 'memory://')
  const c = await makeInstance(id, 'memory://')

  await waitForLeader([a, b, c], 'initial')
  check('a is the elected leader', a.isLeader, true)

  const db = fromPglite(spy(c))
  await applyClockStatement(db, c)
  check('clock setting is on before the leader change', await withTimeout(readClock(db), 'read before'), 'on')

  // Documented limitation, asserted rather than assumed: one leader instance serves every tab, so
  // the SET issued through c's adapter is visible to b's queries too. Not scopeable. Checked before
  // the leader change, so it tests the claim itself and holds in both modes - after the change it
  // would just restate whatever the reapply did.
  const bleed = (await withTimeout(b.query(READ_CLOCK), 'bleed read')).rows[0].v
  check('cross-instance bleed is real (documented limitation)', bleed, 'on')

  await a.close()
  await waitForLeader([b, c], 'follower')
  check('b was promoted, c stayed a follower', `${b.isLeader}/${c.isLeader}`, 'true/false')
  check('clock setting survives on the follower', await withTimeout(readClock(db), 'read after'), 'on')

  await b.close()
  await c.close()
}

async function scenarioInflightStatement () {
  log('\n--- 3. an in-flight statement rejects, and is NOT rolled back ---')
  const id = `harness-inflight-${Date.now()}`
  const a = await makeInstance(id, 'memory://')
  const b = await makeInstance(id, 'memory://')

  const spied = spy(b)
  const db = fromPglite(spied)
  await waitForLeader([a, b], 'initial')
  await applyClockStatement(db, b)
  spied.calls.length = 0

  // Two statements, in two different states when leadership moves, because PGliteWorker treats them
  // differently. `holder` takes the transaction lock; `queued` is still waiting for it.
  const holder = db.executeSql('SELECT pg_sleep(5)')
  holder.catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 250))

  // `queued` is still waiting on _acquireTransactionLock, so its rpc rejects before
  // _runExclusiveTransaction enters its try/finally - which is the path that reaches the adapter.
  const queued = db.executeSql(READ_CLOCK)
  queued.catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 250))

  await a.close()

  check('a queued statement rejects with the leader-change error',
    await outcomeOf(queued, TIMEOUT_MS), LEADER_CHANGED)
  check('no ROLLBACK was sent to the new session', spied.calls.includes('ROLLBACK'), controlMode)

  // Upstream, the holder's own rpc rejects but the `finally` then posts _releaseTransactionLock to a
  // tab channel the new leader has not attached to yet: no reply comes, no second leader-change will
  // fire to reject it, and that await never settles. The adapter now fails its own in-flight
  // statements on a leader change rather than wait on a promise that will never settle, so the
  // holder gets the same error the queued one gets. Pre-fix it hangs, which is what control asserts.
  //
  // Issued through the adapter, so `spied.calls` still sees it - and still must not see a ROLLBACK.
  check('a statement holding the transaction lock does not hang',
    await outcomeOf(holder, 8000), controlMode ? 'HUNG' : LEADER_CHANGED)

  await waitForLeader([b], 'inflight')
  check('the adapter still works after the rejection', await withTimeout(readClock(db), 'read after'), 'on')

  await b.close()
}

async function run () {
  out.textContent = ''
  results.length = 0
  const scenarios = [scenarioPromotedInstance, scenarioFollowerOfNewLeader, scenarioInflightStatement]

  for (const scenario of scenarios) {
    try {
      await scenario()
    } catch (err) {
      results.push({ name: scenario.name, ok: false, actual: err.message, expected: 'no exception' })
      log(`ERROR in ${scenario.name}: ${err.message}`, 'fail')
    }
  }

  const checks = results.filter(r => !r.info)
  const failed = checks.filter(r => !r.ok)
  log(`\n${checks.length - failed.length}/${checks.length} checks passed`, failed.length ? 'fail' : 'pass')
  window.__RESULTS__ = results
  console.log('HARNESS_DONE', JSON.stringify({ passed: checks.length - failed.length, total: checks.length, failed }))
}

document.getElementById('run').addEventListener('click', run)
run()
