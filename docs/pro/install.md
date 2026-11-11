# Install and run

## Requirements

- Node.js 22.12 or later.
- Postgres, with a database for Pro and the databases of the pg-boss applications it monitors. Pro reads a pg-boss schema from version 44 (pg-boss 12.36) on, and makes changes only on the schema of the pg-boss it's built with. See [pg-boss versions](./versions.md).
- A [Pro subscription](https://buy.polar.sh/polar_cl_YGSAhTFmC6APdILc2m8MtIABaLUbAJjSIjooL0pP4lc), which comes with a license key.

## Install

Pro is served from a private registry, not from npmjs. The license key is the only credential the registry needs. The key is shown on the purchases page of the Polar account that bought the subscription.

To run Pro as its own server, create a project for it:

```bash
npm init -y
```

To [mount Pro](./mount.md) in an existing application, install it in that application's project.

Put both lines in the `.npmrc` of the project that installs Pro:

```
//npm.pgboss.io/:_authToken=<your license key>
@pg-boss:registry=https://npm.pgboss.io
```

npm can write both lines for you, from the project's directory:

```bash
npm config set --location=project @pg-boss:registry https://npm.pgboss.io
npm config set --location=project //npm.pgboss.io/:_authToken <your license key>
```

With the `.npmrc` in place, install Pro:

```bash
npm install @pg-boss/pro
```

In a project of its own, `npm pkg set scripts.start=pg-boss-pro` lets `npm start` run it.

The second line points the whole `@pg-boss` scope at the private registry. The `@pg-boss/dashboard` and `@pg-boss/proxy` packages keep resolving from npmjs, because the registry redirects anything that isn't Pro.

In CI, keep the token out of the file. The same `.npmrc` works on a laptop and in a pipeline, because npm substitutes the variable when it reads the file:

```
//npm.pgboss.io/:_authToken=${PGBOSS_PRO_TOKEN}
@pg-boss:registry=https://npm.pgboss.io
```

## Databases

Pro connects to two kinds of database:

- The `PGBOSS_PRO_DB_` settings name Pro's own database, which holds its accounts, rules, alerts and audit log.
- `DATABASE_URL` names the databases Pro monitors, each one the database an application's pg-boss uses. As in the dashboard, it takes several databases separated by `|`, each with an optional name (`Production=postgres://…`). See [databases](./databases.md).

Create a database for Pro, owned by the role Pro connects to it as:

```sql
CREATE ROLE pgboss_pro LOGIN PASSWORD '<password>';
CREATE DATABASE pgboss_pro OWNER pgboss_pro;
```

Point Pro at it with `PGBOSS_PRO_DB_HOST` and `PGBOSS_PRO_DB_PASSWORD`. The other settings default to the role and database above:

| Setting | Default |
| - | - |
| `PGBOSS_PRO_DB_HOST` | required |
| `PGBOSS_PRO_DB_PORT` | `5432` |
| `PGBOSS_PRO_DB_DATABASE` | `pgboss_pro` |
| `PGBOSS_PRO_DB_USER` | `pgboss_pro` |
| `PGBOSS_PRO_DB_PASSWORD` | |
| `PGBOSS_PRO_DB_SSLMODE` | |

`PGBOSS_PRO_DB_CONNECTION_STRING` replaces them all, for a host that gives out a connection string. See [environment variables](./environment.md).

Pro keeps its tables in `public`. The pg-boss that runs Pro's alert evaluator and sends its notifications keeps its job tables in `pgboss`, as an application's pg-boss does. As the owner, the role can create both and migrate them after an upgrade. Other roles can't read Pro's tables unless they're granted access. Restoring an application's database leaves Pro's rules, alerts and audit log as they were. Dropping Pro's database removes Pro.

Pro refuses a database in `DATABASE_URL` as its own. On first start, it also refuses a `public` or `pgboss` that already holds tables, other than an extension's. Pro logs the reason at startup and answers every request with it until the setting is fixed.

## Database permissions

In each monitored database's pg-boss schema, Pro reads what its pages show and makes changes through pg-boss's own methods, such as `createQueue()`, `retry()` and `deleteJob()`. Connect as the role that owns pg-boss's schema. Grants on its tables aren't enough. Creating or deleting a queue with [`partition`](../api/queues.md#createqueue-name-queue) attaches or drops a table, which Postgres allows only to the table's owner. Pro doesn't migrate pg-boss's schema.

Installing pg-boss's schema needs the CREATE privilege on the database, even into an empty schema that already exists. With `PGBOSS_PRO_INSTALL_SCHEMA=false`, Pro installs nothing there and needs no CREATE for pg-boss.

Instance health reads `pg_stat_activity`. A role without `pg_read_all_stats` sees other roles' sessions without their state. For that role, the connection counts by state can read low.

The following is a sample script that grants these permissions in a monitored database:

```sql
GRANT CREATE ON DATABASE mydb TO leastprivuser;
GRANT pg_read_all_stats TO leastprivuser;
```

## Run

On startup, Pro installs pg-boss's schema in each monitored database that has none, as pg-boss's own `start()` does. Pro also runs on a new database. It installs only into a schema that's missing or empty. A schema that holds other tables, such as an application's after a typo in `PGBOSS_SCHEMA`, is left alone, and so is one whose name an existing pg-boss install uses with other capitals. Pro logs why. `PGBOSS_PRO_INSTALL_SCHEMA=false` turns the install off.

Pro also needs a key to encrypt the secrets it stores, such as webhook URLs, PagerDuty keys and the
outgoing email password. Generate the key once and keep it with the application's other secrets:

```bash
openssl rand -base64 32
```

Set it on every start. A different key means entering those secrets again. Without one, Pro starts
and logs a warning. The screens that store secrets then refuse to save. See [secrets](./administration.md#secrets).

```bash
PGBOSS_PRO_DB_HOST="localhost" \
PGBOSS_PRO_DB_PASSWORD="<password>" \
DATABASE_URL="postgres://user:password@localhost:5432/mydb" \
PGBOSS_PRO_SECRET_KEY="<your secret key>" \
npx pg-boss-pro
```

On first run there are no accounts. Pro prints a setup link to its log:

```
pg-boss Pro: no account yet. Open /setup?token=… to create the first global administrator. The link works until this process restarts.
```

Open the setup link (for example `http://localhost:3000/setup?token=…`) and create the first global administrator. Whoever reaches a new install first can't take it, because the page refuses anyone without the token. The token is new each time the process starts. With several instances behind a load balancer, set [`PGBOSS_PRO_SETUP_TOKEN`](./environment.md) so they share one token, and open `/setup?token=` followed by its value. The token needs 32 characters or more, such as the output of `openssl rand -base64 32`. After five wrong tokens from one address in fifteen minutes, or fifty from every address together, the page refuses tokens for fifteen minutes. The page closes for good once the first account exists.

![Creating the first global administrator](../images/pro/setup.webp){.light-only}
![Creating the first global administrator](../images/pro/setup-dark.webp){.dark-only}

## First alert

Pro starts every database with [default rules](./alert-rules.md#default-rules). Six of them are
on. Their alerts show in the Console from the start. To have them sent:

1. Add a destination under **Settings › Destinations**: an email list, a webhook or PagerDuty. Pro
   offers to send the rules that are on to it.
2. For an email destination, set up **Outgoing email** on the same page, with an SMTP server or a
   Resend API key.
3. Press **Send test** on the destination's row. It sends a sample alert that fires and then resolves.

Webhook and PagerDuty destinations and outgoing email store secrets and need `PGBOSS_PRO_SECRET_KEY`. See [destinations](./destinations.md).

## Before production

- Set `PGBOSS_PRO_SECRET_KEY`, as in [Run](#run).
- Back up Pro's database and keep a copy of the secret key apart from it. See [Backup](#backup).
- Set `PGBOSS_DASHBOARD_SITE_URL` to the Console's public address. Without it, emails, webhooks and
  PagerDuty carry no link to the alert. Behind a proxy that ends HTTPS, actions need it too. See
  [reverse proxy](../dashboard.md#reverse-proxy).
- Behind a reverse proxy on another host, set `PGBOSS_PRO_TRUSTED_PROXIES` to its address. Pro then
  reads each client's address from `X-Forwarded-For`, for sign-in limits and the
  [audit log](./audit-log.md#address).
- With several instances behind a load balancer, set `PGBOSS_PRO_SETUP_TOKEN` before the first
  start. The setup link then works on every instance.
- Point the load balancer's health check at `/healthz`, after the base path when one is set. It
  answers 200 once Pro's own schema is ready and 503 until then. It needs no sign-in.

## Docker

With the CI form of `.npmrc` above, pass the license key as a build secret so that no image layer keeps it.
The image copies `package-lock.json`. Run `npm install` in the project once before the first build:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=pgboss_pro_token \
    PGBOSS_PRO_TOKEN="$(cat /run/secrets/pgboss_pro_token)" npm ci
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["npx", "pg-boss-pro"]
```

```bash
PGBOSS_PRO_TOKEN=<your license key> docker build --secret id=pgboss_pro_token,env=PGBOSS_PRO_TOKEN -t pgboss-pro .
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

```bash
npm update @pg-boss/pro
```

Each Pro release is built with one pg-boss release, and installs that release whatever version the application runs. When the application moves to a pg-boss release with a new schema version, upgrade Pro with it. See [pg-boss versions](./versions.md).

## Database uninstall

To remove Pro, drop its database:

```sql
DROP DATABASE pgboss_pro;
```

Dropping it deletes Pro's accounts, rules, alerts and audit log. The monitored databases and their jobs stay as they are.
