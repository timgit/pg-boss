# pg-boss versions

Each Pro release is built with one pg-boss release, and makes changes only in a database on that release's schema version. pg-boss itself refuses to start on any other version, so Pro checks first and says so, for each database it serves:

- **On the schema Pro is built for,** everything works.
- **On another schema,** every page keeps working, and a banner on each names the database's version and this Pro's. Changes are off: sending, retrying, canceling, resuming and deleting jobs, [Operations](./operations.md), creating and deleting queues and schedules, and changes through [the API](./api.md). Their controls are gone, a request for one is refused with the same reason, and an operation confirmed before pg-boss was upgraded fails with it as it runs. Upgrade pg-boss in your application, or upgrade Pro, so the two match.
- **Before schema version 44,** pages also leave out what that schema does not store, such as the instance registry and wait and run times.

Pro installs the exact pg-boss release it is built with, whatever your application runs. A release's range is in its `package.json`: `min` is the oldest schema it reads, `max` the one it makes changes on.

```bash
node -p "require('./node_modules/@pg-boss/pro/package.json').pgBoss.schema"
# { min: 44, max: 46 }
```

| Pro | pg-boss | Schemas read | Changes on |
| - | - | - | - |
| 1.0.x | 12.38.x | 44 to 46 | 46 |
