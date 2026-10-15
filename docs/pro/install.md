# Install and run

## Requirements

- Node.js 22.12 or later.
- A Postgres database with a pg-boss schema, version 44 (pg-boss 12.36) or later. Pro makes changes only on the schema of the pg-boss it is built with: see [pg-boss versions](./versions.md).
- A Pro subscription, which gives you a license key.

## Install

Pro is served from a private registry, not from npmjs. Your license key is the registry credential. It is shown on your Polar purchases page, and it is the only credential involved.

Put both lines in the `.npmrc` of the project that installs Pro:

```
//npm.pgboss.io/:_authToken=<your license key>
@pg-boss:registry=https://npm.pgboss.io
```

Then install it:

```bash
npm install @pg-boss/pro
```

The second line points the whole `@pg-boss` scope at the private registry. The free packages, `@pg-boss/dashboard` and `@pg-boss/proxy`, keep resolving from npmjs: the registry redirects anything that is not Pro.

In CI, keep the token out of the file. npm substitutes the variable when it reads `.npmrc`, so the same file works on a laptop and in a pipeline:

```
//npm.pgboss.io/:_authToken=${PGBOSS_PRO_TOKEN}
@pg-boss:registry=https://npm.pgboss.io
```

## Run

```bash
DATABASE_URL="postgres://user:password@localhost:5432/mydb" npx pg-boss-pro
```

Open `http://localhost:3000`. On first run there are no accounts, so open `/setup` and create the first administrator. That page closes for good once the first account exists.

Pro keeps its own tables, accounts, rules, alerts and the audit log among them, in a `pgboss_pro` schema it creates and migrates on startup, separate from pg-boss's. Nothing in it touches your job tables. Every variable is listed under [environment variables](./environment.md).

`DATABASE_URL` takes several databases, as the free dashboard's does, separated by `|`, each optionally named (`Production=postgres://…`). See [databases](./databases.md).

## Docker

With the CI form of `.npmrc` above, pass the license key as a build secret, so it is not kept in a layer:

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

Each release is built with one pg-boss release, which it installs whatever your application runs. When your application moves to a pg-boss release with a new schema version, upgrade Pro with it. See [pg-boss versions](./versions.md).
