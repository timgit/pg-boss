# Roles and access

Each grant gives a role on one database or on all of them, to a person, a [group](./accounts.md#groups) or a [service account](./api-tokens.md). The same person can be an operator on one database and a viewer on another. Where several grants apply to a database, the user may do everything any of them allows.

| Role | May |
| - | - |
| Viewer | Read. A viewer can't even send a job. |
| Operator | Read, and retry, cancel, resume and send jobs, and acknowledge alerts. |
| Admin | Everything an operator may, and delete jobs, and create and delete queues and schedules. An admin over every database also manages alert rules, accounts, groups, SSO, destinations and settings. |
| Worker | For a service account a worker uses, over the API only: fetch, complete and fail jobs, and send them. Users can't hold it. |

Grants read as the role, then where it applies: `Operator › All databases`, or `Viewer › ● Production` with the database's color.

## Access by database

The accounts list answers the question people ask during an outage, which is who can act on this database and why. Choose the database in **Role on** at `/pro/accounts`, and the list shows each person or service account with a role there, and how many hold each role. Beside each one it shows the role they end up with, and the grant it comes from, directly or through a group, with any weaker grants under it. A role granted for every database appears for each one, and a disabled account shows that it has none.

![Who can act on a database](../images/pro/access.webp){.light-only}
![Who can act on a database](../images/pro/access-dark.webp){.dark-only}

Pro always refuses two changes, and says so. It won't remove the last administrator over every database, by demotion, disabling or deletion, because no administrator would be left to undo it. It also won't let an account disable or delete itself.
