# Alert rules

## The default rules

Every database starts with one rule for each check Pro can run. Five are on:

- **Queue stalled or falling behind**: the queue's health verdict, read from its
  throughput.
- **Nobody working a queue**: jobs are ready and no live instance works the
  queue.
- **No live instance supervising**: nothing is running pg-boss's maintenance.
- **An operation failed**: an operation that failed, or a redrive that left
  collisions.
- **pg-boss warnings**: every warning type pg-boss records.

The instance checks start off: an instance restarting in a loop, an instance gone
quiet, more than one pg-boss version live, instances disagreeing on shared
options, an instance out of pool connections, blocking its event loop, hitting its
CPU limit, or near its memory limit.

None of them tells anybody until you give it a destination, so a new install fills
the bell rather than an inbox. A default rule can be edited and turned off but not
deleted, and **Reset to default** puts back its original definition. A database
added to `DATABASE_URL` later gets its default rules on the evaluator's next pass.

## Writing a rule

**New rule** opens the builder, which writes one of four kinds:

- **Threshold** compares a queue's metrics with numbers you choose. Conditions
  combine with *all* or *any*, with one level of grouping inside, as in "ready
  above 1,000 and (p95 wait above 10 minutes or nothing finishing)". The metrics
  are queued, ready, active, deferred, blocked and total jobs, from pg-boss's
  cached counts; and jobs arriving, finishing and failing per minute, the oldest
  ready job's wait, p95 wait and p95 run time, from the stats pg-boss keeps. No
  rule counts jobs. A queue with no data for a metric does not match a comparison
  on it.
- **Check** is one of the built-in checks above with its settings: which health
  verdicts count and over which interval, how many ready jobs make a queue
  uncovered, how many restarts make a loop.
- **Warning** turns pg-boss warnings into alerts: every type or the ones you pick,
  on every queue or some.
- **Operation** raises an alert for each operation that failed or redrive
  that left collisions.

A threshold or check only raises an alert once it has held for the number of
minutes you set. Every rule has a severity, critical or watch.

Queue rules apply to every queue, to a list, or to names matching patterns, less
any exceptions. A pattern uses `*` for any run of characters and `?` for exactly
one, and matches the whole name. `/` is not special, so `billing-*` matches
`billing-eu/retry`. When two rules that are turned on watch the same queues the
same way, the rule's page names the other one: each raises its own alert.

The rule's page also sets where it sends, at most how often it notifies about the
same thing (60 minutes unless you change it), and **Silence 1h**, for a
deploy or a maintenance window. A silenced rule still raises alerts and tells
nobody, and the silence ends by itself.

## As JSON

The **JSON** switch on the editor shows the same rule as its definition. It is
checked as you type against the schema every save is parsed with, so a message
under the editor is the one a save would give, at the path it applies to.
Unknown keys are errors. Each metric has one fixed unit (jobs, per minute or
seconds), so `"value": 600` on `waitP95Seconds` is ten minutes.

```json
{
  "kind": "threshold",
  "database": "production",
  "queues": { "match": "glob", "values": ["billing-*"], "except": ["billing-dlq"] },
  "when": {
    "match": "all",
    "conditions": [
      {
        "match": "any",
        "conditions": [
          { "metric": "completedPerMinute", "op": "eq", "value": 0 },
          { "metric": "waitP95Seconds", "op": "gt", "value": 600 }
        ]
      },
      { "metric": "ready", "op": "gt", "value": 1000 }
    ]
  },
  "holdMinutes": 5,
  "severity": "critical"
}
```

A save stores the definition in a normal order, so conditions you ordered by hand
can come back sorted.

## Versions

Every change to what a rule decides is kept as a version, and a version can never
be changed afterward. The definition is what is versioned; the name, destination,
notification interval, on or off and silence are not, so changing them adds no
version. Saving the same definition again adds nothing. Going back to an earlier
one adds a new version, which the rule's history marks as the same as the earlier
one. Each version has a page that shows its definition and what changed between
it and the current one.

Each alert keeps the version that raised it, and its page links there. When a
rule changes while it has open alerts, they keep their version, and from the next
pass the new definition judges. An alert that no longer matches closes as "the
rule changed", so nobody reads it as the problem fixing itself. Turning a rule off
closes its alerts as "the rule was turned off", and deleting one closes them as
"the rule was deleted". A deleted rule's versions stay readable from the alerts
that point at them.

## What rules need from pg-boss

- Warning rules read what `persistWarnings` stores. With it off there are no
  warnings to match.
- Health, and the per-minute rates in thresholds, read the stats
  `persistQueueStats` keeps (pg-boss 12.35 or later). Waits and run times need
  pg-boss 12.36, and so do the instance checks, which read its instance registry.
- The evaluator runs once a minute as a pg-boss job in a `<schema>_queue` schema
  of its own, with a singleton key, so two console replicas evaluate once between
  them rather than sending everything twice.
