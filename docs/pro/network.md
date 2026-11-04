# Network activity

**Pro makes no outbound connection of its own.** It has no
telemetry, analytics, phone-home, version check or network license check, at boot
or at any time after. It verifies the license offline, against a public key
compiled into this package.

Each connection below starts from a setting or a command a user ran. With none
set up, Pro talks only to its Postgres database.

| What | When | Where |
|---|---|---|
| `npm install` | at install or upgrade | `npm.pgboss.io`, the configured registry |
| `npx pg-boss-pro-license` | when a user runs it | `npm.pgboss.io/license` |
| A webhook alert | only once a webhook destination exists, when a rule sending to it fires or its alert closes, or a user sends a test | the URL on that destination |
| A PagerDuty alert | only once a PagerDuty destination exists, at the same moments | `events.pagerduty.com` |
| An email alert | only once an email destination exists, at the same moments | the configured SMTP server, or `api.resend.com` |
| Single sign-on | when a user signs in or presses Test | the provider's issuer, token and key endpoints |

The license command sends the token and receives a signed license. It sends
nothing about the database, its jobs, the deployment, or the machine it runs on.

Alert deliveries carry what the alert is about: the rule name, the warning type
and message, the queue and database it names, and the time. They don't include
job payloads.

## Private addresses

By default a webhook or SMTP destination may point anywhere Pro can reach,
because a mail relay or a chat server on the same network is the usual setup.
Set `PGBOSS_PRO_BLOCK_PRIVATE_ADDRESSES=true` to keep webhook and SMTP
destinations on the public internet. Pro then refuses any destination whose host resolves to a loopback,
private, link-local, shared or other non-public address, and the destination's
deliveries say why. It checks the address it connects to, so a host name can't pass the
check and then resolve somewhere private. PagerDuty and Resend are public
already. Single sign-on isn't covered, because providers often run on the
internal network. Its endpoints must use https, or http on localhost.

To keep network activity to the install alone, skip the license command. Set
`PGBOSS_PRO_LICENSE` from a license fetched elsewhere, or run unlicensed, and
configure no destinations or SSO.
