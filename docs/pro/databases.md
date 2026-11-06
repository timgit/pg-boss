# Databases

Pro shows one connected database at a time. Every page about a database shows its name and a colored
dot at the start of the top bar. When `DATABASE_URL` lists more than one database, a menu
there switches between them.

**Settings › Databases** is visible only to [global admins](./roles.md#global-admin) and lists each database by its id. A global admin sets a
friendly name, such as Production or Test, with the pencil beside a database. A name saves when you press Enter or
leave the field, and falls back to the id when it's empty. A color saves when you pick it.
Names show in the database menu, in alert emails and webhook
payloads (`databaseName`, beside `databaseId`), and in the audit log. Renaming
here keeps every link, alert rule and history row, because they all refer to the
database's id, which comes from its name in `DATABASE_URL`. Renaming a database in `DATABASE_URL`
changes the id, so rename it here instead. Adding or removing a database still happens in
`DATABASE_URL`.

![The databases page](../images/pro/databases.webp){.light-only}
![The databases page](../images/pro/databases-dark.webp){.dark-only}

Some of the Pro Console is about one database and some about the whole install. A page
about one database shows that database at the start of the top bar; Settings and
Profile name the area there instead.

| Per database | Console-wide |
| - | - |
| Overview, queues, jobs, schedules, subscriptions | Accounts, groups and access |
| Instances, migrations and warnings | The audit log, which names each entry's database and filters by it |
| Alerts and alert rules, and the bell | Alert destinations, which every database's rules share |
| Status and Operations | Databases and SSO |
| Sending, retrying, canceling and deleting jobs, and queue and schedule changes | Profile |
| The API at `/pro/api/v1/<database>` | Service accounts and their tokens |

A role is granted for one database or for all databases, so the same user can be an
operator on one database and a viewer on another. The Console remembers the last database
viewed for 30 days, so a page that names none, such as Settings, leads back to it.
