# Network activity

**The dashboard makes no outbound connection of its own.** There is no
telemetry, no analytics, no phone-home, no version check, and no license check
over the network: not at boot, not periodically, not on a schedule. The license
is verified offline, against a public key compiled into this package.

Everything below is something you configured, to somewhere you chose. Configure
none of it and the dashboard talks to your Postgres database and nothing else.

| What | When | Where |
|---|---|---|
| `npm install` | when you install or upgrade | `npm.pgboss.io`, the registry you configured |
| `npx pg-boss-pro-license` | when you run it | `npm.pgboss.io/license` |
| A webhook alert | when one of your rules fires or its alert closes, or you send a test | the URL on that destination |
| A PagerDuty alert | the same | `events.pagerduty.com` |
| An email alert | the same | your SMTP server, or `api.resend.com` |
| Single sign-on | when somebody signs in, and when you press Test | your provider's issuer, token and key endpoints |

The license command sends your token and receives a signed license. It sends
nothing about your database, your jobs, your deployment, or your machine.

Alert deliveries carry what the alert is about: the rule name, the warning type
and message, the queue and database it names, and the time. They do not carry
job payloads.

For zero network activity beyond the install: skip the license command, set
`PGBOSS_PRO_LICENSE` from a license you fetched elsewhere or run unlicensed, and
configure no destinations or SSO.
