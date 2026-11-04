# Audit log

`/pro/audit` lists every change made through the Pro Console and the [Pro API](./api.md), except the job calls a service account isn't [set to record](./api-tokens.md), newest first: who made it, what it was, the database it was made in, and when. An entry's page shows the state on either side of the change and the address it came from.

![The audit log](../images/pro/audit-log.webp){.light-only}
![The audit log](../images/pro/audit-log-dark.webp){.dark-only}

Pro writes each change to the log in the same transaction as the change itself. For a change pg-boss makes, it writes the entry first. Pro doesn't make a change it can't record, and a refusal leaves no entry claiming otherwise.

![An audit entry](../images/pro/audit-entry.webp){.light-only}
![An audit entry](../images/pro/audit-entry-dark.webp){.dark-only}

- Filter by **Who** made the change (a person or a service account), **What** kind of change it was (jobs and queues, alerts, accounts and tokens, groups, sign-ins, settings, API calls, one or several), the **Database** it was made in, and **When** (the last 24 hours, 7, 30 or 90 days). **No database** shows the changes that belong to no single database, such as accounts, groups and settings.
- The filters in force show as chips under the filter row, each removable on its own. A link from another page can also filter by what the entries are about (**About**) or by one exact action, and those show as chips too.
- Each row names what the change was about, such as the account, group, rule or queues, and the address it came from.
- **Export CSV** downloads the entries on screen, under the same filters.
- An account's page links to the entries it made (**Activity**) and to its sign-in history, and a group's page to the entries about the group (**History**).
- A change made with an API token names the service account and the token.
- Pro keeps the log forever unless a global admin sets a number of days, 30 or more, with **Change** under the page title. See [retention](./administration.md#retention).

Only a [global admin](./roles.md#global-admin) can open the log.

## Address

The address on an entry is the one the connection came from. When that connection is a trusted proxy's, Pro reads the `X-Forwarded-For` header from its right end, where each proxy adds the address it saw, and takes the first entry that isn't a trusted proxy. The trusted proxies are loopback unless [`PGBOSS_PRO_TRUSTED_PROXIES`](./environment.md) lists others, such as the address of a proxy in another container. From any other connection the header is ignored, so a client can't choose the address recorded.

Behind a proxy that isn't listed, every entry carries the proxy's address. When a private address that isn't listed sends `X-Forwarded-For`, Pro warns once on stderr, naming the address to add. Behind a CDN in front of a trusted proxy, the address is the CDN's.

A handler [mounted in another server](./mount.md) is passed a request without its connection, so it records the `clientIp` each call passes, and none without it. The sign-in and API token limits count failures against the same address.
