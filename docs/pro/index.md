# pg-boss Pro

pg-boss Pro is built for teams running pg-boss in production. It has two components, the Pro Console in the browser and the Pro API over HTTP. In the Pro Console, users make changes such as creating queues and jobs or modifying schedules, as their [role](./roles.md) allows, and every change is recorded in the audit log. Through the Pro API, scripts, CI jobs and other systems call pg-boss's methods using an API token. Pro also adds enhanced health monitoring and a configurable rules engine, which can alert whoever is on call by email, webhook or a paging service, so a stalled queue is caught before it turns into an outage.

Pro is built and supported by the author of pg-boss, and upgrading from the [free dashboard](../dashboard.md) is a change of package name, from `@pg-boss/dashboard` to `@pg-boss/pro`.

![The Pro overview](../images/pro/overview.webp){.light-only}
![The Pro overview](../images/pro/overview-dark.webp){.dark-only}

## Features

- One install of Pro watches any number of pg-boss databases, such as Production and Staging. Each [connected database](./databases.md) gets a name and a color, and roles, alert rules, the Pro API and metrics are all set per database.
- The Console sends, retries, cancels, resumes and deletes jobs, creates and deletes queues and schedules, and runs [Operations](./operations.md) over every job a filter matches. Access is role-based per database, and people can sign in with [single sign-on](./sso.md) through an existing OpenID Connect provider.
- The [Pro API](./api.md) serves pg-boss's own methods per connected database, so a deploy script, a CI job or a worker written in another language can send, fetch, complete and retry jobs without a Node.js client. Each call carries an [API token](./api-tokens.md), and the token's role decides which methods it may call.
- [Alert rules](./alert-rules.md) decide what is an alert: a queue stalled or falling behind, nobody working a queue, a threshold on a queue's counts, rates and waits, pg-boss warnings, or an operation that failed. Alerts reach email, a webhook in Prometheus Alertmanager's format, or a [paging service](./destinations.md), and Pro tells the destination when each alert closes. Each rule has its own thresholds, queues and the time a condition must hold. Pro keeps every change to a rule as a [version](./alert-rules.md#versions) to compare with the current one or restore.
- Pro shows each queue's throughput, wait and run times, time to drain, and whether it's keeping up. It also shows [ninety days of status](./status.md) and the [instances](./instances.md) working each queue.
- [Accounts and groups](./accounts.md) get [roles](./roles.md) per database, and an [audit log](./audit-log.md) records every change.
- Pro serves [Prometheus metrics](./metrics.md) at `/metrics`, for existing dashboards and alerting to scrape.

## Free dashboard and Pro

Pro includes every page of the free dashboard. The first rows below are what the two share, and the rest are Pro's alone.

| Feature | Free dashboard | Pro |
| - | :-: | :-: |
| Overview, queues and each queue's counts over time | ✓ | ✓ |
| Jobs, filtered by state, queue and payload, with each job's details | ✓ | ✓ |
| Schedules, subscriptions and warnings | ✓ | ✓ |
| Registered pg-boss instances | ✓ | ✓ |
| Background migration status | ✓ | ✓ |
| Several databases in one install | ✓ | ✓ |
| Password sign-in | ✓ | ✓ |
| Mounting in an existing Node server, or under a sub-path | ✓ | ✓ |
| [Send, retry, cancel, resume and delete jobs](./changes.md) | | ✓ |
| [Create and delete queues and schedules](./changes.md) | | ✓ |
| [Operations](./operations.md) over every job a filter matches, and redrive | | ✓ |
| [Queue health](./queues.md#health), throughput, wait and run times, and time to drain | | ✓ |
| [Ninety days of status](./status.md) | | ✓ |
| [Instance CPU, memory, connection pool and event loop](./instances.md) | | ✓ |
| [Alert rules](./alert-rules.md) | | ✓ |
| Alerts by [email, webhook or PagerDuty](./destinations.md) | | ✓ |
| [Accounts and groups](./accounts.md), with [roles](./roles.md) per database | | ✓ |
| [Single sign-on](./sso.md) through OpenID Connect | | ✓ |
| [Audit log](./audit-log.md) | | ✓ |
| [Pro API](./api.md) with [API tokens](./api-tokens.md) | | ✓ |
| [Prometheus metrics](./metrics.md) | | ✓ |
| Support from the author of pg-boss | | ✓ |

## Pricing

Pro costs $1,000 a year or $100 a month for one organization, with no limit on people, installations or databases. After twelve months paid in total, an organization that stops paying keeps the right to install and run every version released before the subscription ended. While it lasts, a subscription includes every newer version, and support. See [the license](./license.md).

[Buy Pro](https://buy.polar.sh/polar_cl_YGSAhTFmC6APdILc2m8MtIABaLUbAJjSIjooL0pP4lc). Polar takes the payment and shows the license key on its purchases page.

Pro connects only to the places its configuration names. See [network activity](./network.md).

## Getting started

1. [Install and run](./install.md) it.
2. Open `/setup` and create the first administrator.
3. Give the default alert rules a [destination](./destinations.md), so their alerts reach somebody.
