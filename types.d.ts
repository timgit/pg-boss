import { EventEmitter } from 'events'

declare namespace PgBoss {

  type JobStates = {
    created : 'created',
    retry: 'retry',
    active: 'active',
    completed: 'completed',
    cancelled: 'cancelled',
    failed: 'failed'
  }

  type QueuePolicies = {
    standard: 'standard'
    short: 'short',
    singleton: 'singleton',
    stately: 'stately'
  }
  interface Db {
    executeSql(text: string, values: any[]): Promise<{ rows: any[] }>;
  }

  interface DatabaseOptions {
    application_name?: string;
    database?: string;
    user?: string;
    password?: string | (() => string) | (() => Promise<string>);
    host?: string;
    port?: number;
    schema?: string;
    ssl?: any;
    connectionString?: string;
    max?: number;
    db?: Db;
  }

  interface QueueOptions {
    monitorStateIntervalSeconds?: number;
    monitorStateIntervalMinutes?: number;
  }

  interface SchedulingOptions {
    schedule?: boolean;

    clockMonitorIntervalSeconds?: number;
    clockMonitorIntervalMinutes?: number;

    cronMonitorIntervalSeconds?: number;
    cronWorkerIntervalSeconds?: number;
  }

  interface MaintenanceOptions {
    supervise?: boolean;
    migrate?: boolean;

    deleteAfterSeconds?: number;
    deleteAfterMinutes?: number;
    deleteAfterHours?: number;
    deleteAfterDays?: number;

    maintenanceIntervalSeconds?: number;
    maintenanceIntervalMinutes?: number;

    archiveCompletedAfterSeconds?: number;
    archiveFailedAfterSeconds?: number;
  }

  type ConstructorOptions =
    DatabaseOptions
    & QueueOptions
    & SchedulingOptions
    & MaintenanceOptions
    & ExpirationOptions
    & RetentionOptions
    & RetryOptions
    & JobPollingOptions

  interface ExpirationOptions {
    expireInSeconds?: number;
    expireInMinutes?: number;
    expireInHours?: number;
  }

  interface RetentionOptions {
    retentionSeconds?: number;
    retentionMinutes?: number;
    retentionHours?: number;
    retentionDays?: number;
  }

  interface RetryOptions {
    retryLimit?: number;
    retryDelay?: number;
    retryBackoff?: boolean;
  }

  interface JobOptions {
    id?: string,
    priority?: number;
    startAfter?: number | string | Date;
    singletonKey?: string;
    singletonSeconds?: number;
    singletonMinutes?: number;
    singletonHours?: number;
    singletonNextSlot?: boolean;
    deadLetter?: string;
  }

  interface ConnectionOptions {
    db?: Db;
  }

  type InsertOptions = ConnectionOptions;

  type SendOptions = JobOptions & ExpirationOptions & RetentionOptions & RetryOptions & ConnectionOptions;

  type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately'

  type Queue = RetryOptions & ExpirationOptions & RetentionOptions & { name: string, policy?: QueuePolicy, deadLetter?: string }
  type QueueResult = Queue & { createdOn: Date, updatedOn: Date }
  type ScheduleOptions = SendOptions & { tz?: string }

  interface JobPollingOptions {
    pollingIntervalSeconds?: number;
  }

  interface JobFetchOptions {
    includeMetadata?: boolean;
    priority?: boolean;
    batchSize?: number;
    ignoreStartAfter?: boolean;
  }

  type WorkOptions = JobFetchOptions & JobPollingOptions
  type FetchOptions = JobFetchOptions & ConnectionOptions;

  interface WorkHandler<ReqData> {
    (job: PgBoss.Job<ReqData>[]): Promise<any>;
  }

  interface WorkWithMetadataHandler<ReqData> {
    (job: PgBoss.JobWithMetadata<ReqData>[]): Promise<any>;
  }

  interface Request {
    name: string;
    data?: object;
    options?: SendOptions;
  }

  interface Schedule {
    name: string;
    cron: string;
    data?: object;
    options?: ScheduleOptions;
  }

  // source (for now): https://github.com/bendrucker/postgres-interval/blob/master/index.d.ts
  interface PostgresInterval {
    years?: number;
    months?: number;
    days?: number;
    hours?: number;
    minutes?: number;
    seconds?: number;
    milliseconds?: number;

    toPostgres(): string;

    toISO(): string;
    toISOString(): string;
  }

  interface Job<T = object> {
    id: string;
    name: string;
    data: T;
    expireInSeconds: number;
  }

  interface JobWithMetadata<T = object> extends Job<T> {
    priority: number;
    state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
    retryLimit: number;
    retryCount: number;
    retryDelay: number;
    retryBackoff: boolean;
    startAfter: Date;
    startedOn: Date;
    singletonKey: string | null;
    singletonOn: Date | null;
    expireIn: PostgresInterval;
    createdOn: Date;
    completedOn: Date | null;
    keepUntil: Date;
    deadLetter: string,
    policy: QueuePolicy,
    output: object
  }

  interface JobInsert<T = object> {
    id?: string,
    name: string;
    data?: T;
    priority?: number;
    retryLimit?: number;
    retryDelay?: number;
    retryBackoff?: boolean;
    startAfter?: Date | string;
    singletonKey?: string;
    singletonSeconds?: number;
    expireInSeconds?: number;
    keepUntil?: Date | string;
    deadLetter?: string;
  }

  interface MonitorState {
    all: number;
    created: number;
    retry: number;
    active: number;
    completed: number;
    cancelled: number;
    failed: number;
  }

  interface MonitorStates extends MonitorState {
    queues: { [queueName: string]: MonitorState };
  }

  interface Worker {
    id: string,
    name: string,
    options: WorkOptions,
    state: 'created' | 'active' | 'stopping' | 'stopped'
    count: number,
    createdOn: Date,
    lastFetchedOn: Date,
    lastJobStartedOn: Date,
    lastJobEndedOn: Date,
    lastJobDuration: number,
    lastError: object,
    lastErrorOn: Date
  }

  interface StopOptions {
    close?: boolean,
    graceful?: boolean,
    timeout?: number,
    wait?: boolean
  }

  interface OffWorkOptions {
    id: string
  }

}

declare class PgBoss extends EventEmitter {
  constructor(connectionString: string);
  constructor(options: PgBoss.ConstructorOptions);

  static getConstructionPlans(schema: string): string;
  static getConstructionPlans(): string;

  static getMigrationPlans(schema: string, version: string): string;
  static getMigrationPlans(schema: string): string;
  static getMigrationPlans(): string;

  static getRollbackPlans(schema: string, version: string): string;
  static getRollbackPlans(schema: string): string;
  static getRollbackPlans(): string;

  static states: PgBoss.JobStates
  static policies: PgBoss.QueuePolicies

  on(event: "error", handler: (error: Error) => void): this;
  off(event: "error", handler: (error: Error) => void): this;

  on(event: "maintenance", handler: () => void): this;
  off(event: "maintenance", handler: () => void): this;

  on(event: "monitor-states", handler: (monitorStates: PgBoss.MonitorStates) => void): this;
  off(event: "monitor-states", handler: (monitorStates: PgBoss.MonitorStates) => void): this;

  on(event: "wip", handler: (data: PgBoss.Worker[]) => void): this;
  off(event: "wip", handler: (data: PgBoss.Worker[]) => void): this;

  on(event: "stopped", handler: () => void): this;
  off(event: "stopped", handler: () => void): this;

  start(): Promise<PgBoss>;
  stop(options?: PgBoss.StopOptions): Promise<void>;

  send(request: PgBoss.Request): Promise<string | null>;
  send(name: string, data: object): Promise<string | null>;
  send(name: string, data: object, options: PgBoss.SendOptions): Promise<string | null>;

  sendAfter(name: string, data: object, options: PgBoss.SendOptions, date: Date): Promise<string | null>;
  sendAfter(name: string, data: object, options: PgBoss.SendOptions, dateString: string): Promise<string | null>;
  sendAfter(name: string, data: object, options: PgBoss.SendOptions, seconds: number): Promise<string | null>;

  sendThrottled(name: string, data: object, options: PgBoss.SendOptions, seconds: number): Promise<string | null>;
  sendThrottled(name: string, data: object, options: PgBoss.SendOptions, seconds: number, key: string): Promise<string | null>;

  sendDebounced(name: string, data: object, options: PgBoss.SendOptions, seconds: number): Promise<string | null>;
  sendDebounced(name: string, data: object, options: PgBoss.SendOptions, seconds: number, key: string): Promise<string | null>;

  insert(jobs: PgBoss.JobInsert[]): Promise<void>;
  insert(jobs: PgBoss.JobInsert[], options: PgBoss.InsertOptions): Promise<void>;

  fetch<T>(name: string): Promise<PgBoss.Job<T>[]>;
  fetch<T>(name: string, options: PgBoss.FetchOptions & { includeMetadata: true }): Promise<PgBoss.JobWithMetadata<T>[]>;
  fetch<T>(name: string, options: PgBoss.FetchOptions): Promise<PgBoss.Job<T>[]>;

  work<ReqData>(name: string, handler: PgBoss.WorkHandler<ReqData>): Promise<string>;
  work<ReqData>(name: string, options: PgBoss.WorkOptions & { includeMetadata: true }, handler: PgBoss.WorkWithMetadataHandler<ReqData>): Promise<string>;
  work<ReqData>(name: string, options: PgBoss.WorkOptions, handler: PgBoss.WorkHandler<ReqData>): Promise<string>;

  offWork(name: string): Promise<void>;
  offWork(options: PgBoss.OffWorkOptions): Promise<void>;

  notifyWorker(workerId: string): void;

  subscribe(event: string, name: string): Promise<void>;
  unsubscribe(event: string, name: string): Promise<void>;
  publish(event: string): Promise<void>;
  publish(event: string, data: object): Promise<void>;
  publish(event: string, data: object, options: PgBoss.SendOptions): Promise<void>;

  cancel(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>;
  cancel(name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>;

  resume(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>;
  resume(name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>;

  retry(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>;
  retry(name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>;

  deleteJob(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>;
  deleteJob(name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>;

  complete(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>;
  complete(name: string, id: string, data: object, options?: PgBoss.ConnectionOptions): Promise<void>;
  complete(name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>;

  fail(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>;
  fail(name: string, id: string, data: object, options?: PgBoss.ConnectionOptions): Promise<void>;
  fail(name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>;

  getJobById<T>(name: string, id: string, options?: PgBoss.ConnectionOptions & { includeArchive: boolean }): Promise<PgBoss.JobWithMetadata<T> | null>;

  createQueue(name: string, options?: PgBoss.Queue): Promise<void>;
  updateQueue(name: string, options?: PgBoss.Queue): Promise<void>;
  deleteQueue(name: string): Promise<void>;
  purgeQueue(name: string): Promise<void>;
  getQueues(): Promise<PgBoss.QueueResult[]>;
  getQueue(name: string): Promise<PgBoss.QueueResult | null>;
  getQueueSize(name: string, options?: { before: 'retry' | 'active' | 'completed' | 'cancelled' | 'failed' }): Promise<number>;

  clearStorage(): Promise<void>;
  archive(): Promise<void>;
  purge(): Promise<void>;
  expire(): Promise<void>;
  maintain(): Promise<void>;
  isInstalled(): Promise<Boolean>;
  schemaVersion(): Promise<Number>;

  schedule(name: string, cron: string, data?: object, options?: PgBoss.ScheduleOptions): Promise<void>;
  unschedule(name: string): Promise<void>;
  getSchedules(): Promise<PgBoss.Schedule[]>;

  getDb(): PgBoss.Db;
}

export = PgBoss;
