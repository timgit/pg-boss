# Support

Support is by email at [support@pgboss.io](mailto:support@pgboss.io), from the author of pg-boss, while a subscription is current. It's best effort. There's no committed response time and no service level agreement. Section 6 of [`LICENSE`](https://npm.pgboss.io/terms) holds the terms.

## What support covers

- Installing, configuring, upgrading and running any Pro release in the setups these docs describe: [`npm init @pg-boss/pro`](./install.md#install), an [install by hand](./install.md#install-by-hand), [Docker and Docker Compose](./install.md#docker), and a reverse proxy in front.
- Bugs in Pro, and Pro on the pg-boss schemas its release supports. See [pg-boss versions](./versions.md). A fix ships in a new Pro release.
- Pro's side of single sign-on, email, webhooks, PagerDuty and the Pro API.

## What it doesn't cover

- The application's own use of pg-boss: its workers, its queue design and its code.
- Setups the docs don't describe, such as Pro mounted inside another application's server, or shown in a frame on another site.
- Backports to earlier releases, custom development and on-call cover.
- Another system's own configuration: an identity provider, an SMTP server or relay, or a service that receives webhooks.

## Single sign-on

Pro signs in through any provider that follows OpenID Connect. The [single sign-on](./sso.md) page names the Okta and Entra ID behaviors Pro handles. A provider that departs from the standard gets best effort.

## What to send

- The output of `npx pg-boss-pro doctor`, run where Pro runs. It names the Pro version, and it prints no password or key. See [check the install](./install.md#check-the-install).
- How Pro runs: `npm init @pg-boss/pro`, by hand, Docker or Compose, and what sits in front of it.
- What happened, what you expected, and the log lines from around the time.
