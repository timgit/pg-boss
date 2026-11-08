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

With the `.npmrc` in place, install Pro:

```bash
npm install @pg-boss/pro
```

The second line points the whole `@pg-boss` scope at the private registry. The free packages, `@pg-boss/dashboard` and `@pg-boss/proxy`, keep resolving from npmjs, because the registry redirects anything that isn't Pro.

In CI, keep the token out of the file. npm substitutes the variable when it reads `.npmrc`, so the same file works on a laptop and in a pipeline:

```
//npm.pgboss.io/:_authToken=${PGBOSS_PRO_TOKEN}
@pg-boss:registry=https://npm.pgboss.io
```

## Database install

Pro connects to each database in `DATABASE_URL`, and keeps its own tables in the store database (`PGBOSS_PRO_DATABASE_URL`, the first database by default). See [environment variables](./environment.md).

In pg-boss's schema, Pro reads what its pages show and makes changes through pg-boss's own methods, such as `createQueue()`, `retry()` and `deleteJob()`. Connect as the role the application's pg-boss uses, or a role with the same privileges on that schema. Installing pg-boss's schema in a database that has none needs the CREATE privilege there. Pro doesn't migrate pg-boss's schema.

In the store database, the role needs the [CREATE](https://www.postgresql.org/docs/current/sql-grant.html) privilege to create Pro's `pgboss_pro` and `pgboss_pro_queue` schemas on first start. Pro migrates them on startup after an upgrade, which needs the role that owns them.

Instance health reads `pg_stat_activity`. A role without `pg_read_all_stats` sees other roles' sessions without their state, so the connection counts by state can read low.

The following is a sample script that grants these permissions:

```sql
GRANT CREATE ON DATABASE mydb TO leastprivuser;
GRANT pg_read_all_stats TO leastprivuser;
```

## Run

`DATABASE_URL` names the database the application's pg-boss uses. On startup, Pro installs pg-boss's schema in each database that has none, as pg-boss's own `start()` does, so Pro also runs on a new database.

```bash
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-pro
```

On first run there are no accounts, so Pro prints a setup link to its log:

```
pg-boss Pro: no account yet. Open /setup?token=… to create the first global administrator. The link works until this process restarts.
```

Open the setup link (for example `http://localhost:3000/setup?token=…`) and create the first global administrator. The page refuses anyone without the token, so whoever reaches a new install first can't take it. The token is new each time the process starts. With several instances behind a load balancer, set [`PGBOSS_PRO_SETUP_TOKEN`](./environment.md) so they share one token, and open `/setup?token=` followed by its value. The page closes for good once the first account exists.

![Creating the first global administrator](../images/pro/setup.webp){.light-only}
![Creating the first global administrator](../images/pro/setup-dark.webp){.dark-only}

Pro uses two schemas of its own, both separate from the application's pg-boss schema:

- `pgboss_pro` holds Pro's tables, such as accounts, rules, alerts and the audit log.
- `pgboss_pro_queue` holds the job tables of the pg-boss that runs the alert evaluator.

Pro needs no database of its own. It creates and migrates both schemas on startup in the first database in `DATABASE_URL`, unless `PGBOSS_PRO_DATABASE_URL` names another. `PGBOSS_PRO_SCHEMA` renames them both, because the second name is the first with `_queue` added. [Environment variables](./environment.md) lists every variable.

As in the free dashboard, `DATABASE_URL` takes several databases separated by `|`, each with an optional name (`Production=postgres://…`). See [databases](./databases.md).

## Docker

With the CI form of `.npmrc` above, pass the license key as a build secret, so no image layer keeps it:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=pgboss_pro_token \
    PGBOSS_PRO_TOKEN="$(cat /run/secrets/pgboss_pro_token)" npm ci
ENV PORT=3000
EXPOSE 3000
CMD ["npx", "pg-boss-pro"]
```

```bash
PGBOSS_PRO_TOKEN=<your license key> docker build --secret id=pgboss_pro_token,env=PGBOSS_PRO_TOKEN -t pgboss-pro .
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
