# License

An organization with a Pro subscription may install and use Pro, and download each new version,
under the terms in [`LICENSE`](https://npm.pgboss.io/terms), which also ships in the package. Read it before buying. Pro
checks no license at runtime.
The registry decides which versions the [license key](./install.md#install) may install.

## Cancellation

A subscription renews until it's cancelled. A cancelled subscription lasts until the end of the period
already paid for. From then on, the registry accepts the license key only for the versions the table
below allows. A deploy that has to download any other version fails. Pro keeps running wherever it's
already installed.

What an organization may still install and use depends on its plan and how long it paid:

| After the subscription ends | Annual, or monthly for 12 months or more | Monthly for less than 12 months |
| - | - | - |
| Use the versions already installed | Yes, permanently | No |
| Install a version released before the subscription ended | Yes | No |
| Install a version released after the subscription ended | No | No |
| Support | No | No |

On a monthly subscription under 12 months, Pro keeps running only so that a lapse never takes a
dashboard away without warning. Running past the end gives no right to keep using Pro. See section 2
of [`LICENSE`](https://npm.pgboss.io/terms).

### Upgrading pg-boss after the subscription ends

Each Pro release makes changes only on the schema version of the pg-boss it's built with. When the
application upgrades to a pg-boss release with a new schema version, the installed Pro can't make
changes on that schema. The organization can't install the Pro release built for that schema,
because that release came out after the subscription ended. Every page still works, but changes are off, as [pg-boss
versions](./versions.md) describes. The [dashboard](../dashboard.md#job-actions) follows every
pg-boss release and still retries, cancels and resumes a job.

### Subscribing again

An organization that subscribes again can install new versions, starting from the current release.
Nothing is owed for the time between.

## Access grants

An organization can also receive Pro without a purchase, for example as a pg-boss sponsor or for a
trial. An access grant comes with its own license key. The [install steps](./install.md#install) are
the same as for a purchase. The grant lasts until the license key expires or is revoked, and it can
be revoked at any time. The conditions sent with the license key can also change.

When an access grant ends, the registry refuses its license key for every version. Time under an
access grant doesn't count toward the 12 months in the table above. The right to use the installed versions
ends with the grant, as it does for a monthly subscription under 12 months. See section 2 of
[`LICENSE`](https://npm.pgboss.io/terms).
