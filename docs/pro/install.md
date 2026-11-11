# Install and run

## Requirements

- Node.js 22.12 or later.
- A Postgres database for Pro.
- pg-boss 12.36 or later in each database Pro monitors. See [pg-boss versions](./versions.md).
- A [Pro subscription](https://buy.polar.sh/polar_cl_YGSAhTFmC6APdILc2m8MtIABaLUbAJjSIjooL0pP4lc), which comes with a license key.

## Install

Pro is installed from a private registry, not from npmjs. The license key is the only credential the registry needs. The key is shown on the purchases page of the Polar account that bought the subscription.

To run Pro as its own server, create a project for it and point npm at Pro's registry:

```bash
npm init -y
npm config set --location=project //npm.pgboss.io/:_authToken '${PGBOSS_PRO_LICENSE}'
npm config set --location=project @pg-boss:registry https://npm.pgboss.io
```

The project's `.npmrc` names the variable `PGBOSS_PRO_LICENSE` in place of the license key. The file holds no secret and can be committed. The registry line points the whole `@pg-boss` scope at the private registry. The `@pg-boss/dashboard` and `@pg-boss/proxy` packages keep resolving from npmjs, because the registry redirects anything that isn't Pro.

Set `PGBOSS_PRO_LICENSE` to the license key on every machine and CI job that installs or updates Pro. Then install Pro:

```bash
npm install @pg-boss/pro
```

## Database setup

Pro keeps its accounts, rules, alerts and audit log in a database of its own. Create it, owned by the role Pro connects to it as:

```sql
CREATE ROLE pgboss_pro LOGIN PASSWORD '<password>';
CREATE DATABASE pgboss_pro OWNER pgboss_pro;
```

Pro uses pg-boss internally to run its alert evaluator and send notifications. Pro's own tables go in `public` and pg-boss's in `pgboss`. As the owner, the role can create both and migrate them after an upgrade.

## Configuration

Pro reads these settings at startup:

| Variable | Needed | What |
| - | - | - |
| `PGBOSS_PRO_DB_HOST` | Always | The host of Pro's database. |
| `PGBOSS_PRO_DB_PASSWORD` | Always | The password of the role Pro connects to its database as. |
| `DATABASE_URL` | Always | The databases Pro monitors. As in the dashboard, several are separated by `\|`, each with an optional name (`Production=postgres://…`). See [databases](./databases.md). |
| `PGBOSS_PRO_SECRET_KEY` | Always | Encrypts the secrets Pro stores, such as webhook URLs, PagerDuty keys and the outgoing email password. Generate it once with `openssl rand -base64 32`. Pro needs at least 32 characters. |
| `PGBOSS_PRO_SITE_URL` | In production | The Console's public address. Without it, emails, webhooks and PagerDuty carry no link to the alert. Behind a proxy that ends HTTPS, actions need it too. See [reverse proxy](../dashboard.md#reverse-proxy). |
| `PGBOSS_PRO_TRUSTED_PROXIES` | Behind a reverse proxy on another host | The proxy's address. Pro then reads each client's address from `X-Forwarded-For`, for sign-in limits and the [audit log](./audit-log.md#address). |
| `PGBOSS_PRO_SETUP_TOKEN` | With several instances behind a load balancer | One setup token the instances share, set before the first start. The setup link then works on every instance. |

Keep the secret key with the application's other secrets and set it on every start. A different key means entering those secrets again. Without one, Pro starts
and logs a warning. The screens that store secrets then refuse to save. See [secrets](./administration.md#secrets).

The other settings for Pro's database default to the role and database above:

| Setting | Default |
| - | - |
| `PGBOSS_PRO_DB_PORT` | `5432` |
| `PGBOSS_PRO_DB_DATABASE` | `pgboss_pro` |
| `PGBOSS_PRO_DB_USER` | `pgboss_pro` |
| `PGBOSS_PRO_DB_SSLMODE` | |

`PGBOSS_PRO_DB_CONNECTION_STRING` replaces them all, for a host that gives out a connection string. [Environment variables](./environment.md) lists every variable.

## Monitored database permissions

In each monitored database's pg-boss schema, Pro reads what its pages show and makes changes through pg-boss's own methods, such as `createQueue()`, `retry()` and `deleteJob()`. Pro doesn't install pg-boss in a monitored database, supervise it, run its schedules or migrate it.

The application's pg-boss creates its schema when it first starts. pg-boss's [CLI](../cli.md) can also create the schema ahead of time. Until then, the Console says pg-boss isn't installed in that database.

Connect as the role that owns pg-boss's schema, because some of Pro's changes need the owner. Creating or deleting a queue with [`partition`](../api/queues.md#createqueue-name-queue) attaches or drops a table, which Postgres allows only to the table's owner.

Instance health reads `pg_stat_activity`. A role without `pg_read_all_stats` sees other roles' sessions without their state. For that role, the connection counts by state can read low. The following script grants `pg_read_all_stats` to the role Pro connects as:

```sql
GRANT pg_read_all_stats TO leastprivuser;
```

## Run

Start Pro with the settings above:

```bash
PGBOSS_PRO_DB_HOST="localhost" \
PGBOSS_PRO_DB_PASSWORD="<password>" \
DATABASE_URL="postgres://user:password@localhost:5432/mydb" \
PGBOSS_PRO_SECRET_KEY="<your secret key>" \
npx @pg-boss/pro
```

On first run there are no accounts. Pro prints a setup link to its log:

```
pg-boss Pro: no account yet. Open /setup?token=… to create the first global administrator. The link works until this process restarts.
```

Open the setup link (for example `http://localhost:3000/setup?token=…`) and create the first global administrator. Whoever reaches a new install first can't take it, because the page refuses anyone without the token. The token is new each time the process starts. With several instances behind a load balancer, set [`PGBOSS_PRO_SETUP_TOKEN`](./environment.md) so they share one token, and open `/setup?token=` followed by its value. The token needs 32 characters or more, such as the output of `openssl rand -base64 32`. After five wrong tokens from one address in fifteen minutes, or fifty from every address together, the page refuses tokens for fifteen minutes. The page closes for good once the first account exists.

![Creating the first global administrator](../images/pro/setup.webp){.light-only}
![Creating the first global administrator](../images/pro/setup-dark.webp){.dark-only}

## First alert

Pro starts every database with [default rules](./alert-rules.md#default-rules). Five of them are
on. Their alerts show in the Console from the start. To have them sent:

1. Add a destination under **Settings › Destinations**: an email list, a webhook or PagerDuty. Pro
   offers to send the rules that are on to it.
2. For an email destination, set up **Outgoing email** on the same page, with an SMTP server or a
   Resend API key.
3. Press **Send test** on the destination's row. It sends a sample alert that fires and then resolves.

Webhook and PagerDuty destinations and outgoing email store secrets and need `PGBOSS_PRO_SECRET_KEY`. See [destinations](./destinations.md).

## Docker

With the `.npmrc` above, pass the license key as a build secret so that no image layer keeps it.
The image copies `package-lock.json`. Run `npm install` in the project once before the first build:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=pgboss_pro_license \
    PGBOSS_PRO_LICENSE="$(cat /run/secrets/pgboss_pro_license)" npm ci
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["./node_modules/.bin/pg-boss-pro"]
```

```bash
PGBOSS_PRO_LICENSE=<your license key> docker build --secret id=pgboss_pro_license,env=PGBOSS_PRO_LICENSE -t pgboss-pro .
```

Pass the settings when the container starts, not when the image is built:

```bash
docker run -p 3000:3000 \
  -e PGBOSS_PRO_DB_HOST="db" \
  -e PGBOSS_PRO_DB_PASSWORD="<password>" \
  -e DATABASE_URL="postgres://user:password@db:5432/mydb" \
  -e PGBOSS_PRO_SECRET_KEY="<your secret key>" \
  pgboss-pro
```

## Backup

Back up Pro's database like any other, with `pg_dump` or the host's snapshots:

```bash
pg_dump --format=custom --file=pgboss_pro.dump --host=localhost --username=pgboss_pro pgboss_pro
```

The backup holds Pro's accounts, rules, alerts, audit log and the notifications waiting to send. It doesn't hold `PGBOSS_PRO_SECRET_KEY`. Keep a copy of the key too, stored apart from the backup. Restored with another key, Pro keeps everything except the stored secrets, which need entering again. See [secrets](./administration.md#secrets).

## Upgrading

Pro doesn't check for new releases itself. To see whether one is available, run this in the project that installs Pro:

```bash
npm outdated @pg-boss/pro
```

To upgrade Pro, run `npm update` in the same project:

```bash
npm update @pg-boss/pro
```

At startup, Pro logs its version. The [release notes](./releases.md) list what each release changes.

Each Pro release is built with one pg-boss release, and installs that release whatever version the application runs. When the application moves to a pg-boss release with a new schema version, upgrade Pro with it. See [pg-boss versions](./versions.md).
