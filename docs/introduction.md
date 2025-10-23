# Intro <!-- {docsify-ignore-all} -->
pg-boss is a job queue powered by Postgres, operated by 1 or more Node.js instances.

pg-boss relies on [SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE), a feature built specifically for message queues to resolve record locking challenges inherent with relational databases. This provides exactly-once delivery and the safety of guaranteed atomic commits to asynchronous job processing.

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (SQL, querying, and backups). It will be especially useful to those already relying on PostgreSQL that want to limit how many systems are required to monitor and support in their architecture.

Internally, pg-boss uses declarative list-based partitioning to expose a single logical `job` table. By default, all queues's jobs will be stored together in a shared table, but this could affect performance if 1 or more of your queues grows significantly or experiences an unexpected backlog. 

If a queue needs to be scaled out, you can create it with a `partition` option that will create a dedicated physical table within the partitioning hierarchy. This storage strategy should offer a balance between maintenance operations and query plan optimization. According to [the docs](https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-BEST-PRACTICES), Postgres should scale to thousands of queues in a partitioning hierarchy quite well, but the decision on how many dedicated tables to use should be based on your specific needs. If your usage somehow exceeds what Postgres partitioning is capable of (congrats!), consider provisioning queues into separate schemas in the target database.

You may use as many Node.js instances as desired to connect to the same Postgres database, even running it inside serverless functions if needed. Each instance maintains a client-side connection pool or you can substitute your own database client, limited to the maximum number of connections your database server (or server-side connection pooler) can accept. If you find yourself needing even more connections, pg-boss can easily be used behind your custom web API.

## Job states

All jobs start out in the `created` state and become `active` via [`fetch(name, options)`](#fetchname-options) or in a polling worker via [`work()`](#work). 

In a worker, when your handler function completes, jobs will be marked `completed` automatically unless previously deleted via [`deleteJob(name, id)`](#deletejobname-id-options). If an unhandled error is thrown in your handler, the job will usually enter the `retry` state, and then the `failed` state once all retries have been attempted. 

Uncompleted jobs may also be assigned to `cancelled` state via [`cancel(name, id)`](#cancelname-id-options), where they can be moved back into `created` via [`resume(name, id)`](#resumename-id-options). Failed jobs can be retried via [`retry(name, id)`](#retryname-id-options).

All jobs that are not actively deleted during processing will remain in `completed`, `cancelled` or `failed` state until they are automatically removed.
