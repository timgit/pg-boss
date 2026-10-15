# Databases

The database you are looking at is named at the start of the top bar on every
page, with a colored dot, and a menu there switches between them when
`DATABASE_URL` lists more than one.

`/pro/databases` gives each one a friendly name, such as Production or
Test, and a color. Names show in the database menu, in alert emails and webhook
payloads (`databaseName`, beside `databaseId`), and in the audit log. Renaming
here keeps every link, alert rule and history row, because they all refer to the
database's id, which comes from its name in `DATABASE_URL`. Renaming it there
changes the id, so rename it here instead. Adding or removing a database is still
done in `DATABASE_URL`. Only administrators can change these.

Some of the console is about one database and some about the whole install. A page
about one database shows that database at the start of the top bar; Settings and your
Profile name the area there instead.

| Per database | Console-wide |
| - | - |
| Overview, queues, jobs, schedules, subscriptions | Accounts, groups and access |
| Instances, migrations and warnings | The audit log, which names each entry's database and filters by it |
| Alerts and alert rules, and the bell | Alert destinations, which every database's rules share |
| Status and Operations | Databases, SSO and the license |
| Sending, retrying, canceling and deleting jobs, and queue and schedule changes | Your profile |
| The API at `/pro/api/v1/<database>` | Service accounts and their tokens |

A role is granted for one database or for all of them, so the same person can be an
operator on one and a viewer on another. The console remembers the last database you
looked at for 30 days, so a page that names none, such as Settings, returns you to it.
