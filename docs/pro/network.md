# Network activity

**The dashboard makes no outbound connection of its own.** It has no
telemetry, analytics, phone-home, version check or network license check, at boot
or at any time after. It verifies the license offline, against a public key
compiled into this package.

Every connection below is one you configured, to a place you chose. If you
configure none of them, the dashboard talks only to your Postgres database.

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
and message, the queue and database it names, and the time. They don't include
job payloads.

To keep network activity to the install alone, skip the license command. Set
`PGBOSS_PRO_LICENSE` from a license you fetched elsewhere, or run unlicensed, and
configure no destinations or SSO.
