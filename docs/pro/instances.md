# Instances

The free dashboard lists every pg-boss instance registered in a database. Pro groups instances by name and host and says what needs attention across them. On an instance's page, it marks the pool, CPU, memory or event loop in amber when the instance is at that limit.

![The instances page](../images/pro/instances.webp){.light-only}
![The instances page](../images/pro/instances-dark.webp){.dark-only}

What needs attention is what the instance [alert rules](./alert-rules.md#default-rules) check:

- a queue with ready jobs that nothing is taking
- an instance restarting in a loop
- an instance gone quiet
- more than one pg-boss version live
- instances with different [shared options](#shared-options)
- a pool out of connections
- a blocked event loop
- a process at its CPU limit or near its memory limit

A queue's page names the instances working it, and its charts mark them starting, stopping and going quiet.

The registry needs pg-boss 12.36 or later. An instance started with `registerInstance: false` works without appearing here.

## Shared options

Live instances should agree on these options, or they undo each other's work. Pro compares each one across the live instances it applies to:

- Every instance: `backend`, `useListenNotify`
- Instances with `supervise` on: `superviseIntervalSeconds`, `maintenanceIntervalSeconds`, `monitorIntervalSeconds`, `bamIntervalSeconds`, `flowIntervalSeconds`, `reindex`, `reindexIntervalSeconds`, `monitorVacuum`, `persistWarnings`, `warningRetentionDays`, `persistQueueStats`, `queueStatRetentionDays`, `warningSlowQuerySeconds`, `warningQueueSize`
- Instances with `schedule` on: `clockMonitorIntervalSeconds`, `cronMonitorIntervalSeconds`, `cronWorkerIntervalSeconds`
