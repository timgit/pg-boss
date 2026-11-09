# Network activity

**Pro makes no outbound connection of its own.** It has no
telemetry, analytics, phone-home, version check or license check, at boot or at
any time after.

Each connection below starts from a setting or a command a user ran. With none
set up, Pro talks only to its Postgres database.

| What | When | Where |
|---|---|---|
| `npm install` | at install or upgrade | `npm.pgboss.io`, the configured registry |
| A webhook alert | only once a webhook destination exists, when a rule sending to it fires or its alert closes, or a user sends a test | the URL on that destination |
| A PagerDuty alert | only once a PagerDuty destination exists, at the same moments | `events.pagerduty.com` |
| An email alert | only once an email destination exists, at the same moments | the configured SMTP server, or `api.resend.com` |
| Single sign-on | when a user signs in or presses **Test connection** | the provider's issuer, token and key endpoints |

Alert deliveries carry no job payloads, only what the alert is about: the rule
name, the warning type and message, the queue and database it names, and the
time.

## Private addresses

By default a webhook or SMTP destination may point anywhere Pro can reach,
because a mail relay or a chat server on the same network is the usual setup.
Set `PGBOSS_PRO_BLOCK_PRIVATE_ADDRESSES=true` to keep webhook and SMTP
destinations on the public internet. Pro then refuses any destination whose host resolves to a loopback,
private, link-local, shared or other non-public address. The destination's
deliveries show the reason. Pro checks the address it connects to. A host name can't pass the
check and then resolve somewhere private. PagerDuty and Resend are public
already. Single sign-on isn't covered, because providers often run on the
internal network. The provider's endpoints must use https, or http on localhost.

To keep network activity to the install alone, configure no destinations or SSO.
