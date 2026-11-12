# Install and run

## Requirements

- Node.js 22.12 or later.
- A Postgres database for Pro.
- pg-boss 12.36 or later in each schema Pro monitors. Each is one pg-boss schema in one database, added in the Pro Console once Pro is running. See [Schemas](./schemas.md) and [pg-boss versions](./versions.md).
- A [Pro subscription](https://buy.polar.sh/polar_cl_YGSAhTFmC6APdILc2m8MtIABaLUbAJjSIjooL0pP4lc), which comes with a license key.

## Install

Pro is installed from a private registry, not from npmjs. To run Pro as its own server, create a project for it and point npm at Pro's registry:

```bash
npm init -y
npm config set --location=project //npm.pgboss.io/:_authToken '${PGBOSS_PRO_LICENSE}'
npm config set --location=project @pg-boss:registry https://npm.pgboss.io
```

The `npm config set` commands above creates a `.npmrc` file and refers to the environment variable `PGBOSS_PRO_LICENSE`, which is your license key. The license key is shown on the purchases page of the Polar account that bought the subscription.

Then, assign the environment variable and install:

```bash
PGBOSS_PRO_LICENSE="<your license key>" \
npm install @pg-boss/pro
```

## Database setup

Pro keeps its accounts, rules, alerts and audit log in a database of its own. Create it, owned by the role Pro connects to it as:

```sql
CREATE ROLE pgboss_pro LOGIN PASSWORD '<password>';
CREATE DATABASE pgboss_pro OWNER pgboss_pro;
```

Pro uses pg-boss internally to run its alert evaluator and send notifications. Pro's own tables go in `public` and pg-boss uses its default schema `pgboss`. Running Pro as the db owner role will have the permissions to create the required database storage and run any migrations after a future upgrade.

## Configuration

Pro reads these settings at startup:

| Variable | Needed | What |
| - | - | - |
| `PGBOSS_PRO_DB_HOST` | Always | The host of Pro's database. |
| `PGBOSS_PRO_DB_PASSWORD` | Always | The password of the role Pro connects to its database as. |
| `PGBOSS_PRO_SECRET_KEY` | Always | The encryption key. This is used to encrypt secrets such as each schema's connection settings, webhook URLs, and email password. This should be at least 32 characters. You can generate one with `openssl rand -base64 32`. |
| `PGBOSS_PRO_SITE_URL` | In production | The public address of the Pro Console and Pro API. Without it, emails, webhooks and PagerDuty carry no link to the alert. Behind a reverse proxy that ends HTTPS, actions need it too. See [reverse proxy](../dashboard.md#reverse-proxy). |
| `PGBOSS_PRO_TRUSTED_PROXIES` | Behind a reverse proxy on another host | The reverse proxy's address. Pro then reads each client's address from `X-Forwarded-For`, for sign-in limits and the [audit log](./audit-log.md#address). |
| `PGBOSS_PRO_SETUP_TOKEN` | With several instances behind a load balancer | One setup token the instances share, set before the first start. The setup link then works on every instance. |

Store the encryption key in another secret store. Rotating the secret key requires re-entering all secrets again. Without `PGBOSS_PRO_SECRET_KEY`, Pro logs an error at startup and serves no pages. See [secrets](./administration.md#secrets).

Pro doesn't read `DATABASE_URL` or `PGBOSS_SCHEMA`, which the dashboard reads. The schemas Pro monitors are added in the Pro Console. See [Schemas](./schemas.md).

The other settings for Pro's database default to the role and database above:

| Setting | Default |
| - | - |
| `PGBOSS_PRO_DB_PORT` | `5432` |
| `PGBOSS_PRO_DB_DATABASE` | `pgboss_pro` |
| `PGBOSS_PRO_DB_USER` | `pgboss_pro` |
| `PGBOSS_PRO_DB_SSLMODE` | |

`PGBOSS_PRO_DB_CONNECTION_STRING` replaces them all, for a host that gives out a connection string. [Environment variables](./environment.md) lists every variable.

## Schema permissions

In each pg-boss schema it monitors, Pro reads what its pages show and makes changes through pg-boss's own methods, such as `createQueue()`, `retry()` and `deleteJob()`. Pro doesn't install pg-boss in a schema's database, supervise it, run its schedules or migrate it.

The application's pg-boss creates its schema when it first starts. pg-boss's [CLI](../cli.md) can also create the schema ahead of time. Until then, the Pro Console says pg-boss isn't installed in the schema.

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

## First schema

After setup, Pro opens **Settings › Schemas**. Press **Add schema** and enter a name, the connection to the database the application's pg-boss uses, and the name of its pg-boss schema. **Test connection** checks the connection before you add the schema. Add one schema for each pg-boss Pro monitors, such as Production and Staging. See [Schemas](./schemas.md).

## First alert

Pro starts every schema with [default rules](./alert-rules.md#default-rules). Six of them are
on. Their alerts show in the Pro Console from the start. To have them sent:

1. Add a destination under **Settings › Destinations**: an email list, a webhook or PagerDuty. Pro
   offers to send the rules that are on to it.
2. For an email destination, set up **Settings › Email** with an SMTP server or a Resend API key.
3. Press **Send test** on the destination's row. A webhook or PagerDuty destination gets a sample
   alert that fires and then resolves. An email destination gets one message.

See [destinations](./destinations.md) for each kind.

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
  -e PGBOSS_PRO_SECRET_KEY="<your secret key>" \
  pgboss-pro
```

## Backup

Back up Pro's database like any other, with `pg_dump` or the host's snapshots:

```bash
pg_dump --format=custom --file=pgboss_pro.dump --host=localhost --username=pgboss_pro pgboss_pro
```

The backup holds Pro's schemas, accounts, rules, alerts, audit log and the notifications waiting to send. It doesn't hold `PGBOSS_PRO_SECRET_KEY`. Keep a copy of the key too, stored apart from the backup. Restored with another key, Pro keeps everything except the stored secrets, which need entering again. See [secrets](./administration.md#secrets).

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
