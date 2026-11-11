# Roles and access

Access comes from grants. A grant gives a person, a [group](./accounts.md#groups) or a [service account](./api-tokens.md) a role on one app or on all apps. The same person can be an operator on one app and a viewer on another. Where several grants apply to a database, the user may do everything any of those grants allows.

| Role | May |
| - | - |
| Viewer | Viewer users have read-only access. |
| Operator | Operator users can retry, cancel, resume and send jobs, and acknowledge alerts. |
| Admin | Admin users can delete jobs, and create and delete queues and schedules. An admin on all apps is a [global admin](#global-admin). |
| Worker | Only a service account can hold this role. A worker uses it to fetch, complete, fail and send jobs through the Pro API. |

Grants read as the role followed by its scope, such as `Operator › All apps` or `Viewer › Production`, where "Production" is an app's name.

## Global admin

An account with the admin role on all apps is a global admin, whether the grant is its own or comes through a group. Only a global admin manages alert rules, accounts, groups, SSO, destinations and settings, and opens the [audit log](./audit-log.md). An admin on one database can't, because an admin who manages accounts could widen their own grant. The accounts list and an account's page show a **Global admin** label beside the name. The first account, made at [setup](./install.md), is a global admin.

## Access by app

The accounts list answers the question people ask during an outage, which is the accounts that can act on this app and the grants their roles come from. Choose the app in the accounts list's **Role on** filter. The list then shows each person or service account with a role there and counts how many hold each role. Beside each account, the list shows the role the account ends up with and the grant that role comes from, directly or through a group. Any weaker grants appear under that grant. A role granted for every app appears for each app. A disabled account shows that it has no role.

![Who can act on an app](../images/pro/access.webp){.light-only}
![Who can act on an app](../images/pro/access-dark.webp){.dark-only}

Pro always refuses two changes, and says so. It won't remove the last global admin, by demotion, disabling or deletion, because nobody would be left to undo it. An account also can't disable or delete itself.
