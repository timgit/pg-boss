# License

Separate from the registry token, and it does a smaller job than you might
expect: it names your company on the Pro page, so anyone looking at the
dashboard can see what it is licensed under. **It does not gate anything.**

![The license page](../images/pro/license.webp){.light-only}
![The license page](../images/pro/license-dark.webp){.dark-only}

To fetch one:

```bash
PGBOSS_PRO_TOKEN=<your license key> npx pg-boss-pro-license
```

That writes `license.json` inside the installed package. Run it in your deploy
pipeline, right after the install:

```bash
npm ci
PGBOSS_PRO_TOKEN=$PGBOSS_PRO_TOKEN npx pg-boss-pro-license
```

The token is the same license key your `.npmrc` uses. It has to be passed
explicitly because npm does not let an installed package read the token out of
`.npmrc`: that is a deliberate npm security boundary, not an oversight here.

## Or hold it as a secret instead

`license.json` lives in `node_modules`, so a fresh `npm ci` removes it. If you
would rather keep the license somewhere durable, fetch it once and store the
string:

```bash
PGBOSS_PRO_TOKEN=<your license key> npx pg-boss-pro-license --print
```

Set the output as `PGBOSS_PRO_LICENSE` in your secret store. The environment
takes precedence over the file, and this is the right path for air-gapped
installs, immutable images, and anywhere `node_modules` is read-only.

`PGBOSS_PRO_LICENSE_FILE` points at a `license.json` somewhere else, if a file
on a mounted volume suits you better than an environment variable.

## When it lapses

Nothing happens. The Pro page says the term ended and that Pro is unaffected.

There is no countdown, no banner, no grace period, and no date on which
features stop. A dashboard is monitoring, and taking someone's monitoring away
over a billing state: usually in front of an operator who cannot do anything
about it: is not a trade worth making. Your subscription controls what you can
*download*. Once you have paid for twelve months in total, a lapsed subscription
still installs the versions released before it ended, forever; before then, a
lapsed one cannot install Pro. Either way it cannot upgrade to a newer version or
fetch a new license. What is already running keeps running, though before twelve
paid months the license to use it ends with the subscription. See `LICENSE`.

Running without a license at all is fine too, and is the normal state of a fresh
`npm ci` that has not run the license command. The page says "Unlicensed" and
everything works.
