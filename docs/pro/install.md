# Install and run

## Requirements

- Node.js 22.12 or later.
- A Postgres database. Pro reads a pg-boss schema from version 44 (pg-boss 12.36) on, and makes changes only on the schema of the pg-boss it's built with. See [pg-boss versions](./versions.md).
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

## Database permissions

Pro connects to each database in `DATABASE_URL`, and keeps its own tables in the store database (`PGBOSS_PRO_DATABASE_URL`, the first database by default). See [environment variables](./environment.md).

In pg-boss's schema, Pro reads what its pages show and makes changes through pg-boss's own methods, such as `createQueue()`, `retry()` and `deleteJob()`. Connect as the role the application's pg-boss uses, or a role with the same privileges on that schema. Installing pg-boss's schema in a database that has none needs the CREATE privilege there. Pro doesn't migrate pg-boss's schema.

In the store database, the role needs the [CREATE](https://www.postgresql.org/docs/current/sql-grant.html) privilege to create Pro's `pgboss_pro` and `pgboss_pro_queue` schemas on first start. Pro migrates them on startup after an upgrade, which needs the role that owns them.

Instance health reads `pg_stat_activity`. A role without `pg_read_all_stats` sees other roles' sessions without their state. For that role, the connection counts by state can read low.

The following is a sample script that grants these permissions:

```sql
GRANT CREATE ON DATABASE mydb TO leastprivuser;
GRANT pg_read_all_stats TO leastprivuser;
```

## Run

`DATABASE_URL` names the database the application's pg-boss uses. On startup, Pro installs pg-boss's schema in each database that has none, as pg-boss's own `start()` does. Pro also runs on a new database. It installs only into a schema that's missing or empty. A schema that holds other tables, such as an application's after a typo in `PGBOSS_SCHEMA`, is left alone, and so is one whose name an existing pg-boss install uses with other capitals. Pro logs why. `PGBOSS_PRO_INSTALL_SCHEMA=false` turns the install off.

Pro also needs a key to encrypt the secrets it stores, such as webhook URLs, PagerDuty keys and the
outgoing email password. Generate the key once and keep it with the application's other secrets:

```bash
openssl rand -base64 32
```

Set it on every start. A different key means entering those secrets again. Without one, Pro starts
and logs a warning, and the screens that store secrets refuse to save. See [secrets](./administration.md#secrets).

```bash
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

Pro uses two schemas of its own, both separate from the application's pg-boss schema:

- `pgboss_pro` holds Pro's tables, such as accounts, rules, alerts and the audit log.
- `pgboss_pro_queue` holds the job tables of the pg-boss that runs the alert evaluator.

Pro needs no database of its own. It creates and migrates both schemas on startup in the first database in `DATABASE_URL`, unless `PGBOSS_PRO_DATABASE_URL` names another. `PGBOSS_PRO_SCHEMA` renames them both, because the second name is the first with `_queue` added. [Environment variables](./environment.md) lists every variable.

As in the dashboard, `DATABASE_URL` takes several databases separated by `|`, each with an optional name (`Production=postgres://…`). See [databases](./databases.md).

## First alert

Pro starts every database with [default rules](./alert-rules.md#default-rules), and six of them are
on. Their alerts show in the Console from the start. To have them sent:

1. Add a destination under **Settings › Destinations**: an email list, a webhook or PagerDuty. Pro
   offers to send the rules that are on to it.
2. For an email destination, set up **Outgoing email** on the same page, with an SMTP server or a
   Resend API key.
3. Press **Send test** on the destination's row. It sends a sample alert that fires and then resolves.

Webhook and PagerDuty destinations and outgoing email store secrets, and need `PGBOSS_PRO_SECRET_KEY`. See [destinations](./destinations.md).

## Before production

- Set `PGBOSS_PRO_SECRET_KEY`, as in [Run](#run).
- Set `PGBOSS_DASHBOARD_SITE_URL` to the Console's public address. Without it, emails, webhooks and
  PagerDuty carry no link to the alert. Behind a proxy that ends HTTPS, actions need it too. See
  [reverse proxy](../dashboard.md#reverse-proxy).
- Behind a reverse proxy on another host, set `PGBOSS_PRO_TRUSTED_PROXIES` to its address. Pro then
  reads each client's address from `X-Forwarded-For`, for sign-in limits and the
  [audit log](./audit-log.md#address).
- With several instances behind a load balancer, set `PGBOSS_PRO_SETUP_TOKEN` before the first
  start. The setup link then works on every instance.
- Point the load balancer's health check at `/healthz`, after the base path when one is set. It
  answers 200 once Pro's own schema is ready, and 503 until then. It needs no sign-in.

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
  -e DATABASE_URL="postgres://user:password@db:5432/mydb" \
  -e PGBOSS_PRO_SECRET_KEY="<your secret key>" \
  pgboss-pro
```

## Upgrading

```bash
npm update @pg-boss/pro
```

Each Pro release is built with one pg-boss release, and installs that release whatever version the application runs. When the application moves to a pg-boss release with a new schema version, upgrade Pro with it. See [pg-boss versions](./versions.md).

## Database uninstall

To remove Pro from a database, drop its two schemas:

```sql
DROP SCHEMA pgboss_pro CASCADE;
DROP SCHEMA pgboss_pro_queue CASCADE;
```

If you set `PGBOSS_PRO_SCHEMA`, use its value and the same name with `_queue` added. Dropping the schemas deletes Pro's accounts, rules, alerts and audit log. pg-boss's schema and the application's jobs stay.
