# Constructor

### `new(connectionString)`

Passing a string argument to the constructor implies a PostgreSQL connection string in one of the formats specified by the [pg](https://github.com/brianc/node-postgres) package.  Some examples are currently posted in the [pg docs](https://github.com/brianc/node-postgres/wiki/pg).

```js
const boss = new PgBoss('postgres://user:pass@host:port/database?ssl=require');
```

### `new(options)`

The following options can be set as properties in an object for additional configurations.

**Connection options**

* **host** - string,  defaults to "127.0.0.1"

* **port** - int,  defaults to 5432

* **ssl** - boolean or object

* **database** - string, *required*

* **user** - string, *required*

* **password** - string

* **connectionString** - string

  PostgreSQL connection string will be parsed and used instead of `host`, `port`, `ssl`, `database`, `user`, `password`.

* **max** - int, defaults to 10

  Maximum number of connections that will be shared by all operations in this instance

* **application_name** - string, defaults to "pgboss"

* **db** - object

    Passing an object named db allows you "bring your own database connection". This option may be beneficial if you'd like to use an existing database service with its own connection pool. Setting this option will bypass the above configuration.

    The expected interface is a function named `executeSql` that allows the following code to run without errors.


    ```js
    const text = "select $1 as input"
    const values = ['arg1']

    const { rows } = await executeSql(text, values)

    assert(rows[0].input === 'arg1')
    ```

* **schema** - string, defaults to "pgboss"

    Database schema that contains all required storage objects. Only alphanumeric and underscore allowed, length: <= 50 characters


**Queue options**

Queue options contain the following constructor-only settings.

* **archiveCompletedAfterSeconds**

    Specifies how long in seconds completed jobs get archived. Note: a warning will be emitted if set to lower than 60s and cron processing will be disabled.

  Default: 12 hours

* **archiveFailedAfterSeconds**

    Specifies how long in seconds failed jobs get archived. Note: a warning will be emitted if set to lower than 60s and cron processing will be disabled.

  Default: `archiveCompletedAfterSeconds`

**Monitoring options**

* **monitorStateIntervalSeconds** - int, default undefined

    Specifies how often in seconds an instance will fire the `monitor-states` event. Must be >= 1.

* **monitorStateIntervalMinutes** - int, default undefined

    Specifies how often in minutes an instance will fire the `monitor-states` event. Must be >= 1.

  > When a higher unit is is specified, lower unit configuration settings are ignored.


**Maintenance options**

Maintenance operations include checking active jobs for expiration, archiving completed jobs from the primary job table, and deleting archived jobs from the archive table.

* **supervise**, bool, default true

  If this is set to false, maintenance and monitoring operations will be disabled on this instance.  This is an advanced use case, as bypassing maintenance operations is not something you would want to do under normal circumstances.

* **schedule**, bool, default true

  If this is set to false, this instance will not monitor or created scheduled jobs during. This is an advanced use case you may want to do for testing or if the clock of the server is skewed and you would like to disable the skew warnings.

* **migrate**, bool, default true

  If this is set to false, this instance will skip attempts to run schema migratations during `start()`. If schema migrations exist, `start()` will throw and error and block usage. This is an advanced use case when the configured user account does not have schema mutation privileges.

**Archive options**

When jobs in the archive table become eligible for deletion.

* **deleteAfterSeconds**, int

    delete interval in seconds, must be >=1

* **deleteAfterMinutes**, int

    delete interval in minutes, must be >=1

* **deleteAfterHours**, int

    delete interval in hours, must be >=1

* **deleteAfterDays**, int

    delete interval in days, must be >=1

* Default: 7 days

  > When a higher unit is is specified, lower unit configuration settings are ignored.

**Maintenance interval**

How often maintenance operations are run against the job and archive tables.

* **maintenanceIntervalSeconds**, int

    maintenance interval in seconds, must be >=1

* **maintenanceIntervalMinutes**, int

    interval in minutes, must be >=1

* Default: 1 minute

  > When a higher unit is is specified, lower unit configuration settings are ignored.
