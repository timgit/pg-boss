# Release notes

## 1.0.0

The first release of pg-boss Pro, on pg-boss 12.38 and dashboard 2.0.

- Alert rules decide what is an alert: thresholds on a queue's counts, rates and waits, the built-in checks, pg-boss warnings and failed operations. Each rule is scoped to queues by name or pattern and edited in a builder or as JSON. Pro keeps every version of a rule, and every alert names its version.
- Alerts reach email, PagerDuty, or a webhook in Prometheus Alertmanager's format, with a link to the alert's page, and Pro tells the destination when the alert closes.
- The Pro API for scripts, CI and workers: pg-boss's own methods on each database, behind API tokens that belong to service accounts with roles like a person's, and Prometheus metrics.
- Each release states the pg-boss schemas it supports. On any other schema the Pro Console keeps showing everything and turns changes off.
- Accounts, groups and roles per database, single sign-on, and an audit log of every change.
- Operations over every job a filter matches, health and throughput on every queue, ninety days of status, and the instances working each queue.
