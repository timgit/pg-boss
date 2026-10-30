# Audit log

`/pro/audit` lists every change made through the Pro Console and the [Pro API](./api.md), newest first: who made it, what it was, the database it was made in, and when. An entry's page shows the state on either side of the change and the address it came from.

![The audit log](../images/pro/audit-log.webp){.light-only}
![The audit log](../images/pro/audit-log-dark.webp){.dark-only}

Pro writes each change to the log in the same transaction as the change itself. For a change pg-boss makes, it writes the entry first. Pro doesn't make a change it can't record, and a refusal leaves no entry claiming otherwise.

![An audit entry](../images/pro/audit-entry.webp){.light-only}
![An audit entry](../images/pro/audit-entry-dark.webp){.dark-only}

- Filter by database. **No database** shows the changes that belong to no single database, such as accounts, groups and settings.
- **Export CSV** downloads the entries on screen, under the same filters.
- A change made with an API token names the service account and the token.
- Pro keeps the log forever unless an administrator sets a number of days, 30 or more, on the same page. See [retention](./administration.md#retention).

Only an administrator over every database can open the log.

## Address

The address on an entry is the one the connection came from. When the connection comes from a private address (loopback, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` or an IPv6 private range), Pro takes it to be a reverse proxy's. It then reads the `X-Forwarded-For` header and takes the last entry that isn't a private address, which is the one the proxy added.

Pro can't tell a proxy from any other machine with a private address, so the address is only as reliable as the network:

- A proxy that reaches Pro from a public address, such as a CDN in front of an origin on a public IP, is recorded as the address, and its header is ignored.
- Anything else that can reach Pro from a private address, such as another pod or VM on the same network, can send its own header and choose the address recorded.
- Behind a CDN in front of a private proxy, the address is the CDN's.

A handler [mounted in another server](./mount.md) is passed a request without its connection, so its entries have no address. The sign-in and API token limits count failures against the same address.
