# Roles and access

A role is granted on one database or on all of them, to a person, to a [group](./accounts.md#groups), or to a [service account](./api-tokens.md), so the same person can be an operator on one database and a viewer on another. Where several grants apply to a database, what someone may do is everything any of them allows.

| Role | May |
| - | - |
| Viewer | Read. Not even send a job. |
| Operator | Read, and retry, cancel, resume and send jobs, and acknowledge alerts. |
| Admin | Everything an operator may, and delete jobs, create and delete queues and schedules, and manage alert rules. An admin over every database also manages accounts, groups, SSO, destinations and settings. |
| Worker | For a service account a worker uses, over the API only: fetch, complete and fail jobs, and send them. Not offered for people. |

Grants read as the role, then where it applies: `Operator › All databases`, or `Viewer › ● Production` with the database's color.

## Who can act on a database

`/pro/access` answers the question asked in an incident: who can act on this database, and why. Choose the database to show, and each person or service account with a role there is listed with the role they end up with beside every grant that produced it, direct or through a group. A role granted for every database appears for each one.

Two changes are always refused, and both say so: removing the last administrator over every database, by demotion, disabling or deletion, since nobody would be left to undo it; and disabling or deleting your own account.
