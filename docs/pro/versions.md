# pg-boss versions

Each Pro release is built with one pg-boss release, and makes changes only in a database on that release's schema version. pg-boss itself refuses to start on any other version, so Pro checks each database it serves first and says what it found:

- **On the schema Pro is built for,** everything works.
- **On another schema,** every page keeps working, and a banner on each names the database's version and this Pro's. Changes are off: sending, retrying, canceling, resuming and deleting jobs, [Operations](./operations.md), creating and deleting queues and schedules, and changes through [the Pro API](./api.md). Pro hides their controls and refuses a request for one with the same reason. An operation confirmed before pg-boss was upgraded fails with that reason when it runs. Upgrade pg-boss in your application, or upgrade Pro, so the two match.
- **Before schema version 44,** pages also leave out what that schema doesn't store, such as the instance registry and wait and run times.

Pro installs the exact pg-boss release it is built with, whatever your application runs. A release's `package.json` holds its range, where `min` is the oldest schema it reads and `max` is the one it makes changes on.

```bash
node -p "require('./node_modules/@pg-boss/pro/package.json').pgBoss.schema"
# { min: 44, max: 46 }
```

| Pro | pg-boss | Schemas read | Changes on |
| - | - | - | - |
| 1.0.x | 12.38.x | 44 to 46 | 46 |
