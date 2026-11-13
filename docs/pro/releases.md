# Release notes

## 1.0.0

The first release of pg-boss Pro, on pg-boss 12.38 and dashboard 2.0.

- Pro keeps its accounts, rules, alerts and audit log in a database of its own. A global admin adds the [schemas](./schemas.md) Pro monitors in the Pro Console.
- Alert rules set the conditions that open an alert: thresholds on a queue's counts, rates and waits, the built-in checks, pg-boss warnings and failed operations. Each rule is scoped to queues by name or pattern and edited in a builder or as JSON. Pro keeps every version of a rule, and every alert names its version.
- Alerts reach email, PagerDuty, or a webhook in Prometheus Alertmanager's format, with a link to the alert's page. Pro tells the destination when the alert closes.
- The Pro API for scripts, CI and workers: pg-boss's own methods on each schema, behind API tokens that belong to service accounts with roles like a person's, and Prometheus metrics.
- Each release states the pg-boss schemas it supports. On any other schema the Pro Console keeps showing everything and turns changes off.
- Accounts, groups and roles per schema, single sign-on, and an audit log of every change.
- Operations over every job a filter matches, health and throughput on every queue, ninety days of status, and the instances working each queue.
- `npm init @pg-boss/pro` sets up a project for Pro. It checks the license key, connects to Pro's database or creates one, writes `.env` with a new secret key, installs Pro and opens the setup page. See [Install](./install.md#install).
- `pg-boss-pro` reads a `.env` file in the project, and `pg-boss-pro doctor` checks the settings and Pro's database without starting Pro. See [check the install](./install.md#check-the-install).

### Upgrading from the dashboard

- Pro's links name the schema with `?schema=`, as the dashboard's links do. Pro opens a link saved from dashboard 1.x at the same URL with `db` renamed `schema`.
- `DATABASE_URL` does nothing in Pro. Add each schema the dashboard showed under **Settings › Schemas**. See [Install and run](./install.md).
