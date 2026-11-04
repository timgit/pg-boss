# License

The License page, only visible to [global admins](./roles.md#global-admin), shows the installed
license. **The license doesn't turn any feature on or off.**

![The license page](../images/pro/license.webp){.light-only}
![The license page](../images/pro/license-dark.webp){.dark-only}

Fetch it with the license key:

```bash
PGBOSS_PRO_TOKEN=<your license key> npx pg-boss-pro-license
```

The command writes `license.json` inside the installed package. Run it in the
deploy pipeline, right after the install:

```bash
npm ci
PGBOSS_PRO_TOKEN=$PGBOSS_PRO_TOKEN npx pg-boss-pro-license
```

The token is the same license key the `.npmrc` uses. The command needs it passed
explicitly, because npm deliberately keeps `.npmrc` tokens out of reach of installed
packages, as a security boundary.

## Storing the license

A fresh `npm ci` removes `license.json`, because it lives in `node_modules`. To
keep the license somewhere durable, fetch it once and store the string:

```bash
PGBOSS_PRO_TOKEN=<your license key> npx pg-boss-pro-license --print
```

Set the output as `PGBOSS_PRO_LICENSE` in a secret store. The environment
variable takes precedence over the file. Use it for air-gapped installs,
immutable images, and anywhere `node_modules` is read-only.

To keep `license.json` on a mounted volume instead, point
`PGBOSS_PRO_LICENSE_FILE` at it.

## Expiration

Pro doesn't stop when a subscription ends. It has no countdown, no banner and
no date when features stop, and the License page shows the term's end date. Pro
is a monitoring tool, and the operator who would lose it over billing usually
can't do anything about billing.

A subscription controls what its holder can *download*:

- After twelve paid months in total, a lapsed subscription still installs every
  version released before it ended, forever.
- Before twelve paid months, a lapsed subscription can't install Pro.
- Either way, a lapsed subscription can't upgrade to a newer version or fetch a
  new license.

What's already running keeps running, until the application upgrades to a
pg-boss release with a new schema version. Each Pro release makes changes only
on the schema of the pg-boss it is built with (see [pg-boss
versions](./versions.md)), and a lapsed subscription can't install the release
built for the new one. From then on, every page still works, and changes are
off: sending, retrying, canceling, resuming and deleting jobs, Operations,
creating and deleting queues and schedules, and every call to the Pro API, which
answers 409. The [free dashboard](../dashboard.md#job-actions)
follows each pg-boss release, and still retries, cancels and resumes a job.

Before twelve paid months, the license to use what's running ends with the
subscription. See `LICENSE`.

Running with no license at all also works. It's the normal state after a fresh
`npm ci` that hasn't run the license command. The page then says "Unlicensed",
and everything works.
