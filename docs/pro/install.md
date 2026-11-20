# Install and run

## Requirements

- Node.js 22.12 or later.
- A Postgres database for Pro, on PostgreSQL 13 or later.
- pg-boss 12.36 or later in each schema Pro monitors. The schemas are added in the Pro Console once Pro is running. See [Schemas](./schemas.md) and [pg-boss versions](./versions.md).
- A [Pro subscription](https://buy.polar.sh/polar_cl_YGSAhTFmC6APdILc2m8MtIABaLUbAJjSIjooL0pP4lc), which comes with a license key.

## Install with the CLI

Pro is installed from a private registry, not from npmjs. Use the setup CLI to install Pro in a new project directory:

```bash
npm init @pg-boss/pro
```

The CLI will prompt for the license key, database connection details, and other setup details. It will then write settings, including a generated secret key, `PGBOSS_PRO_SECRET_KEY`, to the `.env` file. 

> [!IMPORTANT]
> Keep a copy of the secret key in another secret store, just in case you need to restore the database. See [Backup](#backup).

To run the CLI without prompts, as in a script, pass the answers after `--`:

```bash
npm init @pg-boss/pro -- pgboss-pro --yes --license "<your license key>" \
  --database-url "postgres://pgboss_pro:<password>@localhost:5432/pgboss_pro"
```

`npm init @pg-boss/pro -- --help` lists every option.

When the CLI finishes, it prints how to start Pro and a link to create the first global administrator:

```
✓ Pro is installed in /home/you/pgboss-pro.

Secret key

  PGBOSS_PRO_SECRET_KEY in pgboss-pro/.env encrypts the secrets Pro stores.
  Keep a copy of it apart from the database backups, which don't hold it.
  See https://pgboss.io/pro/administration#secrets

Next steps

  1. Start Pro:

       cd pgboss-pro
       node .

  2. Open this link to create the first global administrator:

       http://localhost:3000/setup?token=…

  When Pro doesn't start, this command checks its settings and database:

       npm run doctor
```

## Install manually

To set up the project yourself, point npm at Pro's registry:

```bash
npm init -y
npm config set --location=project //npm.pgboss.io/:_authToken '${PGBOSS_PRO_LICENSE}'
npm config set --location=project @pg-boss:registry https://npm.pgboss.io
```

The `npm config set` commands above create a `.npmrc` file and refer to the environment variable `PGBOSS_PRO_LICENSE`, which is your license key. The license key is shown on the purchases page of the Polar account that bought the subscription.

Then, assign the environment variable and install:

```bash
PGBOSS_PRO_LICENSE="<your license key>" \
npm install @pg-boss/pro
```

Set the project's `main` to Pro's binary, which `node .` then starts, as [Run](#run) explains:

```bash
npm pkg set main=node_modules/@pg-boss/pro/bin/cli.js
```

Then create the database and set the configuration, as the next two sections describe. [Run](#run) then starts Pro.

### Database setup

Pro keeps its accounts, rules, alerts and audit log in a database of its own. Create it, owned by the role Pro connects to it as:

```sql
CREATE ROLE pgboss_pro LOGIN PASSWORD '<password>';
CREATE DATABASE pgboss_pro OWNER pgboss_pro;
```

As the database's owner, the role has the permissions to create Pro's tables and run the migrations in later upgrades.

### Configuration

In a manual install, set these settings yourself:

| Variable | Needed | What |
| - | - | - |
| `PGBOSS_PRO_DB_HOST` | Always | The database host. |
| `PGBOSS_PRO_DB_PASSWORD` | Always | The password of the role Pro connects to its database as. |
| `PGBOSS_PRO_SECRET_KEY` | Always | The encryption key. This is used to encrypt secrets such as each schema's connection settings, webhook URLs, and email password. This should be at least 32 characters. You can generate one with `openssl rand -base64 32`. |
| `PGBOSS_PRO_SITE_URL` | In production | The public address of the Pro Console and Pro API. Without it, emails, webhooks and PagerDuty carry no link to the alert. Behind a reverse proxy that ends HTTPS, actions need it too. See [reverse proxy](../dashboard.md#reverse-proxy). |
| `PGBOSS_PRO_TRUSTED_PROXIES` | Behind a reverse proxy on another host | The reverse proxy's address. Pro then reads each client's address from `X-Forwarded-For`, for sign-in limits and the [audit log](./audit-log.md#address). |
| `PGBOSS_PRO_SETUP_TOKEN` | With several instances behind a load balancer | One setup token the instances share, set before the first start. The setup link then works on every instance. |
| `PGBOSS_PRO_LOG_FORMAT` | With a log collector | Set it to `json` for one JSON object per line, or to `pretty` for reading in a terminal. The default is `text`. See [logging](./environment.md#pgboss-pro-log-format). |

Store the encryption key in another secret store. Rotating the secret key requires entering all secrets again. Without `PGBOSS_PRO_SECRET_KEY`, Pro logs an error that names the setting and exits. See [secrets](./administration.md#secrets).

Pro doesn't read `DATABASE_URL`, which the dashboard reads. The schemas Pro monitors are added in the Pro Console. See [Schemas](./schemas.md).

The other database settings default to the role and database above:

| Setting | Default |
| - | - |
| `PGBOSS_PRO_DB_PORT` | `5432` |
| `PGBOSS_PRO_DB_DATABASE` | `pgboss_pro` |
| `PGBOSS_PRO_DB_USER` | `pgboss_pro` |
| `PGBOSS_PRO_DB_SSLMODE` | |

`PGBOSS_PRO_DB_CONNECTION_STRING` replaces them all, for a host that gives out a connection string. [Environment variables](./environment.md) lists every variable.

Keep Pro's settings in a `.env` file in the project, where the secret key stays out of shell history and survives a restart. The following commands write the settings above to the file with a new secret key, and keep the file out of version control:

```bash
echo "PGBOSS_PRO_DB_HOST=localhost" >> .env
echo "PGBOSS_PRO_DB_PASSWORD=<password>" >> .env
echo "PGBOSS_PRO_SECRET_KEY=$(openssl rand -base64 32)" >> .env
echo ".env" >> .gitignore
```

> [!IMPORTANT]
> Keep a copy of the secret key in another secret store, just in case you need to restore the database. See [Backup](#backup).

## Run

Start Pro in the project. Pro reads the `.env` file in the directory it starts in:

```bash
node .
```

`node .` is preferred since the node process itself receives SIGTERM directly from systemd, Docker or a process manager. Pro uses signals to finish an alert evaluator pass and gracefully close its connections before stopping. npm and npx don't pass SIGTERM on to the process they start. Don't run Pro through them under a supervisor.

In a terminal, however, where Ctrl-C reaches every process, `npx pg-boss-pro` starts Pro too, as does `npm start`. `npm run doctor` runs [the doctor](#check-the-install).

A variable set in the environment takes precedence over the same variable in `.env`. Pro doesn't start without `PGBOSS_PRO_SECRET_KEY` and its database settings, or with a setting it can't use, such as a port that isn't a number. It logs one line that names the setting and exits with status 1. When Pro doesn't start, [check the install](#check-the-install).

On first run there are no accounts. Pro will print a setup link to its log:

```
pg-boss Pro: no global admin found. Open http://localhost:3000/setup?token=… to create the first global admin. The link works until this process restarts.
```

Open the setup link and create the first global administrator. Whoever reaches a new install first can't take it, because the page refuses anyone without the token. Without `PGBOSS_PRO_SETUP_TOKEN`, the token is new each time the process starts. The link then works until the process restarts. The CLI sets the variable. The link it prints keeps working across restarts until the first account exists. With several instances behind a load balancer, set [`PGBOSS_PRO_SETUP_TOKEN`](./environment.md#pgboss-pro-setup-token) so they share one token, and open `/setup?token=` followed by its value. The token needs 32 characters or more, such as the output of `openssl rand -base64 32`. After five wrong tokens from one address in fifteen minutes, or fifty from every address together, the page refuses tokens for fifteen minutes. The page closes for good once the first account exists.

![Creating the first global administrator](../images/pro/setup.webp){.light-only}
![Creating the first global administrator](../images/pro/setup-dark.webp){.dark-only}

## Email server

After setup, Pro opens **Settings › Email**, an optional step. Alert email and invitations go out through this server, which can be any SMTP server Pro reaches. Set it up and press **Save**, or press
**Skip** and set it up later from Settings. Either way, Pro goes on to **Settings › Schemas**.
See [email](./destinations.md#email).

## First schema

On **Settings › Schemas**, press **Add schema** and enter a name, the connection to the database the application's pg-boss uses, and the name of its pg-boss schema. **Test connection** checks the connection before you add the schema. Add one schema for each pg-boss Pro monitors, such as Production and Staging. See [Schemas](./schemas.md).

## First alert

Pro includes a rules engine that opens an alert when one of its rules finds a problem in a schema.
Each schema starts with a set of [default rules](./alert-rules.md#default-rules), some of them
turned on. Their alerts show in the Pro Console from the start. To have them sent by email, webhook
or PagerDuty:

1. Add a destination under **Settings › Destinations**: an email list, a webhook or PagerDuty. Pro
   offers to send the rules that are on to it.
2. For an email destination, set up **Settings › Email** with an SMTP server.
3. Press **Send test** on the destination's row. A webhook or PagerDuty destination gets a sample
   alert that fires and then resolves. An email destination gets one message.

See [destinations](./destinations.md) for each kind.

## Docker

The image reads the license key from `PGBOSS_PRO_LICENSE`, which the `.npmrc` from [Install manually](#install-manually) names. A project from `npm init @pg-boss/pro -- --token-in-env` has the same `.npmrc`. Pass the license key as a build secret so that no image layer keeps it.
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
ENTRYPOINT ["node", "."]
```

The `ENTRYPOINT` starts Pro with `node .`. Pro then receives Docker's SIGTERM itself, as [Run](#run) explains.

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

A project from the CLI can pass its settings with `--env-file .env` in place of the `-e` options. In a container, `localhost` is the container itself. The database host in `.env` has to be one the container reaches, such as `host.docker.internal`.

To [check the install](#check-the-install) in a container, add `doctor` after the image name, with the same settings.

### Docker Compose

Compose runs the `pgboss-pro` image built above beside a Postgres of its own. Compose reads the settings from the project's `.env`. The following commands add a database password and a secret key to it:

```bash
echo "PGBOSS_PRO_DB_PASSWORD=$(openssl rand -hex 24)" >> .env
echo "PGBOSS_PRO_SECRET_KEY=$(openssl rand -base64 32)" >> .env
```

Save the following as `compose.yaml` in the project:

```yaml
services:
  pro:
    image: pgboss-pro
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      PGBOSS_PRO_DB_HOST: db
      PGBOSS_PRO_DB_PASSWORD: ${PGBOSS_PRO_DB_PASSWORD:?set it in .env}
      PGBOSS_PRO_SECRET_KEY: ${PGBOSS_PRO_SECRET_KEY:?set it in .env}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: pgboss_pro
      POSTGRES_DB: pgboss_pro
      POSTGRES_PASSWORD: ${PGBOSS_PRO_DB_PASSWORD:?set it in .env}
    volumes:
      - pgboss_pro_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pgboss_pro -d pgboss_pro"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pgboss_pro_data:
```

Then start both containers, and check the install in the `pro` container:

```bash
docker compose up -d
docker compose run --rm pro doctor
```

The Postgres image creates the `pgboss_pro` role and database the first time it starts with an empty volume. It reads `POSTGRES_PASSWORD` only then. To change the password later, change it in `.env` and run `ALTER ROLE pgboss_pro PASSWORD` with the same value.

Pro waits for Postgres to report healthy before it starts. The database publishes no port, because only Pro connects to it. Pro's port is published on `127.0.0.1` alone, which keeps a first run off the network. To serve it from a server, publish `3000:3000` or put a reverse proxy in front, and set [`PGBOSS_PRO_SITE_URL`](./environment.md#pgboss-pro-site-url).

`extra_hosts` makes `host.docker.internal` resolve on Linux as it does on macOS and Windows. A schema whose database runs on the Docker host is added in the Pro Console with `host.docker.internal` as its host.

The database in the volume and the secret key in `.env` are on the same machine. Keep a copy of the key somewhere else. See [Backup](#backup).

To upgrade, run `npm update @pg-boss/pro`, build the image again with the `docker build` command above, and run `docker compose up -d`.

## Offline install

Pro runs without internet access. The registry checks the license key when it serves the package. Once installed, Pro doesn't check its license or contact pgboss.io. A network that can't reach npm.pgboss.io gets Pro from a machine that can, in one of three ways. Keep every copy inside your organization, because the [license](./license.md) doesn't allow making Pro available to anyone outside it.

### Docker image

On a machine that reaches npm.pgboss.io, build the image as [Docker](#docker) shows. Push the image to the network's container registry, or save it to a file to carry in:

```bash
docker save pgboss-pro | gzip > pgboss-pro.tar.gz
```

Inside the network, load the image from the file:

```bash
docker load < pgboss-pro.tar.gz
```

### Project copy

On a machine that reaches npm.pgboss.io and npmjs, install Pro in a project as [Install with the CLI](#install-with-the-cli) or [Install manually](#install-manually) shows. Copy the project directory into the network with its `node_modules`, and start Pro there as [Run](#run) shows. None of Pro's dependencies is a native module. The copy runs on any operating system and processor with Node.js 22.12 or later.

To upgrade, run `npm update @pg-boss/pro` in the project outside the network, then copy the project again.

### Internal registry

An internal npm registry, such as Artifactory, Nexus or Verdaccio, can proxy Pro's registry for the projects inside the network. Give it two upstream registries:

- `https://npm.pgboss.io` for `@pg-boss/pro` alone, sending the license key as a bearer token (`Authorization: Bearer <license key>`)
- npmjs for every other package, including the rest of the `@pg-boss` scope

Pro's registry serves only `@pg-boss/pro`. It redirects a request for any other package to npmjs, which a proxy may not follow. Projects inside the network then install Pro from the internal registry with no `.npmrc` entry for npm.pgboss.io.

## Production

Pro runs as its own server, apart from your application's, at the root of a host name of its own, such as `console.example.com`. Before other people use it, put HTTPS in front of it, keep it running, and point your monitoring at it. Back up the database and keep a copy of the secret key, as [Backup](#backup) describes.

### HTTPS

Pro serves plain HTTP. Put a reverse proxy in front of it that ends HTTPS and passes Pro every path on its host name. Pro doesn't serve under a path of another site. This Nginx configuration forwards the client's address and scheme, which Pro reads for sign-in limits, the audit log and its cookies:

```nginx
server {
    listen 443 ssl;
    server_name console.example.com;
    ssl_certificate /etc/ssl/certs/console.example.com.pem;
    ssl_certificate_key /etc/ssl/private/console.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set [`PGBOSS_PRO_SITE_URL`](./environment.md#pgboss-pro-site-url) to the address people open, such as `https://console.example.com`. Links in alerts use it. Actions behind the proxy need it too. Pro trusts the address a proxy on the same machine forwards. For a proxy on another host, list its address in [`PGBOSS_PRO_TRUSTED_PROXIES`](./environment.md#pgboss-pro-trusted-proxies).

Served over HTTPS, Pro sends `Strict-Transport-Security` with a one-year `max-age` and no `includeSubDomains`. A browser that has opened the Pro Console over HTTPS then uses only HTTPS on that host for a year, for every path on it.

### Service

Docker Compose restarts Pro with `restart: unless-stopped`. On a server without Docker, run Pro as a systemd service. Save the following as `/etc/systemd/system/pgboss-pro.service`, with the project's directory and the path `command -v node` prints:

```ini
[Unit]
Description=pg-boss Pro
After=network-online.target
Wants=network-online.target

[Service]
User=pgboss-pro
WorkingDirectory=/opt/pgboss-pro
ExecStart=/usr/bin/node .
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`node .` makes Pro the service's main process, which systemd stops with SIGTERM. Pro reads `.env` from its working directory. The file is readable by its owner alone. `User` names the account that owns the project. Then start Pro, and start it again at each boot:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pgboss-pro
```

`journalctl -u pgboss-pro` shows Pro's log.

### Several instances

Several instances of Pro behind one load balancer evaluate each schema's rules once between them and send from every destination's queue. Give every instance the same Pro database and the same `PGBOSS_PRO_SECRET_KEY`. With the same key, each instance decrypts the secrets the others stored and finishes an SSO sign-in another one started. Set [`PGBOSS_PRO_SETUP_TOKEN`](./environment.md#pgboss-pro-setup-token) on all of them too, for a setup link that works on any one.

### Monitoring

- Keep [`PGBOSS_PRO_LOG_FORMAT`](./environment.md#pgboss-pro-log-format) at `json`, as the CLI sets it, for a log collector.
- Point the load balancer's health check at [`/healthz`](./metrics.md#health-check).
- Scrape [`/metrics`](./metrics.md#prometheus) with Prometheus.
- Point the monitoring you already run at [`/alertz`](./metrics.md#health-check), which answers 503 when Pro is down or its alerts fall behind.

## Backup

Back up the database like any other, with `pg_dump` or the host's snapshots:

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

## Check the install

The `doctor` command checks Pro's settings and database without starting the server. Run it in the project, where it reads the same `.env` file:

```bash
npx pg-boss-pro doctor
```

It reports each check as passed or failed, with the fix for each failure:

- The secret key, the log format when `PGBOSS_PRO_LOG_FORMAT` is set, and the setup token when one is set.
- The connection to the database, and whether it's behind a pooler in transaction mode.
- Pro's tables, against the version this release uses. Tables from a later Pro mean the install is older than the release that last migrated the database.
- Each schema whose connection is Pro's database, which isn't monitored.
- Whether a global admin can sign in, with a password or through SSO. See [global admin recovery](./accounts.md#global-admin-recovery).
- The stored secrets, decrypted with the current key. See [key changes](./administration.md#key-changes).

The doctor exits with status 1 when a check fails. It writes to the database only when you make an account a global admin after a failed **Global admin** check. It doesn't connect to the schemas Pro monitors, which Settings › Schemas checks. See [Schemas](./schemas.md).

```
pg-boss Pro 1.0.0

✓ Secret key: PGBOSS_PRO_SECRET_KEY is set.
✓ Database: Connected to localhost:5432/pgboss_pro.
✓ Pro's tables: At version 1, which this Pro uses.
✓ Global admin: A global admin can sign in with a password.
✓ Stored secrets: They were saved with this PGBOSS_PRO_SECRET_KEY.
```
