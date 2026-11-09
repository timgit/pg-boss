# pg-boss versions

Each Pro release is built with one pg-boss release, and makes changes only in a database on that release's schema version. Pro checks the schema version of each database it serves first, because pg-boss itself refuses to start on any other version. Pro's behavior depends on that version:

- **On the schema Pro is built for,** everything works.
- **On another schema,** every page keeps working. A banner on each page names the database's version and the version this Pro is built for. Changes are off: sending, retrying, canceling, resuming and deleting jobs, [Operations](./operations.md), creating and deleting queues and schedules, and every call to [the Pro API](./api.md), reads included. The Pro API answers each call with 409. Pro hides the controls for these changes and refuses any request for them with the same reason. An operation confirmed before pg-boss was upgraded fails with that reason when it runs. To make the two match, upgrade pg-boss in the application or upgrade Pro.
- **Before schema version 44,** the banner asks for an upgrade of pg-boss, because 44 is the oldest schema this Pro reads. Pages still open, but leave out what that schema doesn't store, such as the instance registry and wait and run times.

Each pg-boss release with a new schema version gets a Pro release built with it on the same day. Upgrade the two together. Pro installs the exact pg-boss release it is built with, whatever the application runs. A release's `package.json` holds its range, where `min` is the oldest schema it reads and `max` is the schema it makes changes on.

```bash
node -p "require('./node_modules/@pg-boss/pro/package.json').pgBoss.schema"
# { min: 44, max: 46 }
```

| Pro | pg-boss | Schemas read | Changes on |
| - | - | - | - |
| 1.0.x | 12.38.x | 44 to 46 | 46 |
