# Intro <!-- {docsify-ignore-all} -->
pg-boss is a job queue powered by Postgres, operated by 1 or more Node.js instances.

pg-boss relies on [SKIP LOCKED](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/), a feature built specifically for message queues to resolve record locking challenges inherent with relational databases. This provides exactly-once delivery and the safety of guaranteed atomic commits to asynchronous job processing.

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (SQL, querying, and backups). It will be especially useful to those already relying on PostgreSQL that want to limit how many systems are required to monitor and support in their architecture.

Internally, pg-boss uses declarative list-based partitioning to create a physical table per queue within 1 logical job table. This partitioning strategy is a balance between global maintenance operations, queue storage isolation, and query plan optimization. According to [the docs](https://www.postgresql.org/docs/13/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-BEST-PRACTICES), this strategy should scale to thousands of queues. If your usage exceeds this and you experience performance issues, consider grouping queues into separate schemas in the target database.

You may use as many Node.js instances as desired to connect to the same Postgres database, even running it inside serverless functions if needed. Each instance maintains a client-side connection pool or you can substitute your own database client, limited to the maximum number of connections your database server (or server-side connection pooler) can accept. If you find yourself needing even more connections, pg-boss can easily be used behind your custom web API.

## Job states

All jobs start out in the `created` state and become `active` via [`fetch(name, options)`](#fetchname-options) or in a polling worker via [`work()`](#work). 

In a worker, when your handler function completes, jobs will be marked `completed` automatically unless previously deleted via [`deleteJob(name, id)`](#deletejobname-id-options). If an unhandled error is thrown in your handler, the job will usually enter the `retry` state, and then the `failed` state once all retries have been attempted. 

Uncompleted jobs may also be assigned to `cancelled` state via [`cancel(name, id)`](#cancelname-id-options), where they can be moved back into `created` via [`resume(name, id)`](#resumename-id-options).

All jobs that are `completed`, `cancelled` or `failed` become eligible for archiving according to your configuration. Once archived, jobs will be automatically deleted after the configured retention period.
