# License

An organization with a Pro subscription may install and use Pro, and download each new version,
under the terms in the `LICENSE` file that ships in the package. Pro checks no license at runtime.
The registry decides which versions the [license key](./install.md#install) may install.

## Cancellation

A subscription renews until it's canceled. A canceled subscription lasts until the end of the period
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
of `LICENSE`.

### Upgrading pg-boss after the subscription ends

Each Pro release makes changes only on the schema version of the pg-boss it's built with. When the
application upgrades to a pg-boss release with a new schema version, the installed Pro can't make
changes on that schema. The organization can't install the Pro release built for that schema,
because that release came out after the subscription ended. Every page still works, but changes are off, as [pg-boss
versions](./versions.md) describes. The [free dashboard](../dashboard.md#job-actions) follows every
pg-boss release and still retries, cancels and resumes a job.

### Subscribing again

An organization that subscribes again can install new versions, starting from the current release.
Nothing is owed for the time between.
