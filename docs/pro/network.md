# Network activity

**The dashboard makes no outbound connection of its own.** It has no
telemetry, analytics, phone-home, version check or network license check, at boot
or at any time after. It verifies the license offline, against a public key
compiled into this package.

Each connection below starts from a setting or a command someone ran. With none
of them set up, the dashboard talks only to its Postgres database.

| What | When | Where |
|---|---|---|
| `npm install` | at install or upgrade | `npm.pgboss.io`, the configured registry |
| `npx pg-boss-pro-license` | when someone runs it | `npm.pgboss.io/license` |
| A webhook alert | only once a webhook destination exists, when a rule sending to it fires or its alert closes, or someone sends a test | the URL on that destination |
| A PagerDuty alert | only once a PagerDuty destination exists, at the same moments | `events.pagerduty.com` |
| An email alert | only once an email destination exists, at the same moments | the configured SMTP server, or `api.resend.com` |
| Single sign-on | when somebody signs in or presses Test | the provider's issuer, token and key endpoints |

The license command sends the token and receives a signed license. It sends
nothing about the database, its jobs, the deployment, or the machine it runs on.

Alert deliveries carry what the alert is about: the rule name, the warning type
and message, the queue and database it names, and the time. They don't include
job payloads.

To keep network activity to the install alone, skip the license command. Set
`PGBOSS_PRO_LICENSE` from a license fetched elsewhere, or run unlicensed, and
configure no destinations or SSO.
