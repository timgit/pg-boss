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
| A PagerDuty alert | only once a PagerDuty destination exists, at the same moments | `events.pagerduty.com`, or `events.eu.pagerduty.com` for a destination in the EU region |
| An email alert | only once an email destination exists, at the same moments, or when a global admin presses **Send test** under **Settings › Email** | the configured SMTP server |
| An invitation email | when a global admin sends an invitation from an account's page, or adds a person with **Email the link to this address** checked | the configured SMTP server |
| A schema's database | only once a schema is added, when a page, the alert evaluator or an operation reads or changes it | the host in that schema's connection |
| Single sign-on | when a user signs in or presses **Test connection** | the provider's issuer, token and key endpoints |

Alert deliveries carry no job payloads, only what the alert is about: the rule
name, the warning type and message, the queue and schema it names, and the
time.

## Private addresses

By default a webhook or SMTP destination may point anywhere Pro can reach,
because a mail relay or a chat server on the same network is the usual setup.
Set `PGBOSS_PRO_BLOCK_PRIVATE_ADDRESSES=true` to keep webhook and SMTP
destinations on the public internet. Pro then refuses any destination whose host resolves to a loopback,
private, link-local, shared or other non-public address. The destination's
deliveries show the reason. Pro checks the address it connects to. A host name can't pass the
check and then resolve somewhere private. PagerDuty is public
already. Single sign-on isn't covered, because providers often run on the
internal network. The provider's endpoints must use https, or http on localhost.

## Egress proxy

Set `HTTPS_PROXY`, or `HTTP_PROXY`, to send webhooks, PagerDuty and single sign-on through a
proxy. Hosts in `NO_PROXY` are reached directly, such as an internal identity provider. Through a
proxy, the proxy resolves and connects. With `PGBOSS_PRO_BLOCK_PRIVATE_ADDRESSES` also set, Pro checks
a webhook's host before it sends, but the proxy makes the connection. SMTP doesn't go through the
proxy.

To keep network activity to the install alone, configure no destinations or SSO.
