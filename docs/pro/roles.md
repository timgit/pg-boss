# Roles and access

Access comes from grants. A grant gives a person, a [group](./accounts.md#groups) or a [service account](./api-tokens.md) a role on one database or on all databases. The same person can be an operator on one database and a viewer on another. Where several grants apply to a database, the user may do everything any of those grants allows.

| Role | May |
| - | - |
| Viewer | Viewer users are limited to read-only access. |
| Operator | Operator users can retry, cancel, resume and send jobs, and acknowledge alerts. |
| Admin | Admin users can delete jobs, and create and delete queues and schedules. An admin on all databases is a [global admin](#global-admin). |
| Worker | Only a service account can hold it, for a worker using the API to fetch, complete, fail and send jobs. |

Grants read as the role, followed by its scope. For example, `Operator › All databases`, or `Viewer › Production`, where "Production" is the configured database name.

## Global admin

An account with the admin role on all databases is a global admin, whether the grant is its own or comes through a group. Only a global admin manages alert rules, accounts, groups, SSO, destinations and settings, and opens the [audit log](./audit-log.md). An admin on one database can't, because managing accounts would let them widen their own grant. The accounts list and an account's page show a **Global admin** label beside the name. The first account, made at [setup](./install.md), is one.

## Access by database

The accounts list answers the question people ask during an outage, which is who can act on this database and why. Choose the database in **Role on** at `/pro/accounts`, and the list shows each person or service account with a role there, and how many hold each role. Beside each one it shows the role they end up with, and the grant it comes from, directly or through a group, with any weaker grants under it. A role granted for every database appears for each one, and a disabled account shows that it has none.

![Who can act on a database](../images/pro/access.webp){.light-only}
![Who can act on a database](../images/pro/access-dark.webp){.dark-only}

Pro always refuses two changes, and says so. It won't remove the last global admin, by demotion, disabling or deletion, because nobody would be left to undo it. It also won't let an account disable or delete itself.
