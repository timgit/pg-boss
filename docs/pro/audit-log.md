# Audit log

`/pro/audit` lists every change made through the console and the API, newest first: who made it, what it was, the database it was made in, and when. An entry's page shows the state either side of the change and the address it came from.

![The audit log](../images/pro/audit-log.webp){.light-only}
![The audit log](../images/pro/audit-log-dark.webp){.dark-only}

Each change is written to the log in the same transaction as the change itself, or before it for a change pg-boss makes, so a change that cannot be recorded is not made, and a refusal leaves no entry claiming otherwise.

![An audit entry](../images/pro/audit-entry.webp){.light-only}
![An audit entry](../images/pro/audit-entry-dark.webp){.dark-only}

- Filter by database. **Console-wide only** shows the changes about no one database, such as accounts, groups and settings.
- **Export CSV** downloads the entries on screen, under the same filters.
- A change made with an API token names the service account and the token.
- The log is kept forever unless an administrator sets a number of days on the same page, 30 or more. See [retention](./administration.md#retention).

The log is for administrators over every database.
