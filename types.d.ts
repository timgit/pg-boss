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
    password?: string;
    host?: string;
    port?: number;
    schema?: string;
    ssl?: any;
    connectionString?: string;
    max?: number;
    db?: Db;
  }

  interface SchedulingOptions {
    schedule?: boolean;
    clockMonitorIntervalSeconds?: number;
    cronWorkerIntervalSeconds?: number;
    cronMonitorIntervalSeconds?: number;
  }

  interface MaintenanceOptions {
    supervise?: boolean;
    migrate?: boolean;
    warningSlowQuerySeconds?: number;
    warningLargeQueueSize?: number;
  }

  type ConstructorOptions = DatabaseOptions & SchedulingOptions & MaintenanceOptions

  interface QueueOptions {
    expireInSeconds?: number;
    retentionSeconds?: number;
    deleteAfterSeconds?: number;
    retryLimit?: number;
    retryDelay?: number;
    retryBackoff?: boolean;
  }

  interface JobOptions {
    id?: string;
    priority?: number;
    startAfter?: number | string | Date;
    singletonKey?: string;
    singletonSeconds?: number;
    singletonNextSlot?: boolean;
  }

  interface ConnectionOptions {
    db?: Db;
  }

  type InsertOptions = ConnectionOptions;

  type SendOptions = JobOptions & QueueOptions & ConnectionOptions;

  type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately'

  type Queue = {
    name: string;
    policy?: QueuePolicy;
    partition?: boolean;
    deadLetter?: string;
    queueSizeWarning?: number;
  } & QueueOptions

  type QueueResult = Queue & {
    deferredCount: number;
    queuedCount: number;
    activeCount: number;
    completedCount: number;
    table: number;
    createdOn: Date;
    updatedOn: Date;
  }

  type ScheduleOptions = SendOptions & { tz?: string }

  interface JobPollingOptions {
    pollingIntervalSeconds?: number;
  }

  interface JobFetchOptions {
    includeMetadata?: boolean;
    priority?: boolean;
    batchSize?: number;
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
    expireInSeconds: number;
    deleteAfterSeconds: number;
    createdOn: Date;
    completedOn: Date | null;
    keepUntil: Date;
    policy: QueuePolicy;
    deadLetter: string;
    output: object;
  }

  interface JobInsert<T = object> {
    id?: string;
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
    deleteAfterSeconds: number;
    keepUntil?: Date | string;
  }

  interface Worker {
    id: string;
    name: string;
    options: WorkOptions;
    state: 'created' | 'active' | 'stopping' | 'stopped';
    count: number;
    createdOn: Date;
    lastFetchedOn: Date;
    lastJobStartedOn: Date;
    lastJobEndedOn: Date;
    lastJobDuration: number;
    lastError: object;
    lastErrorOn: Date;
  }

  interface StopOptions {
    close?: boolean;
    graceful?: boolean;
    timeout?: number;
    wait?: boolean;
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

  on(event: "warning", handler: (warning: { message: string, data: object }) => void): this;
  off(event: "warning", handler: (warning: { message: string, data: object }) => void): this;

  on(event: "wip", handler: (data: PgBoss.Worker[]) => void): this;
  off(event: "wip", handler: (data: PgBoss.Worker[]) => void): this;

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

  insert(name: string, jobs: PgBoss.JobInsert[]): Promise<void>;
  insert(name: string, jobs: PgBoss.JobInsert[], options: PgBoss.InsertOptions): Promise<void>;

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

  deleteJob(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>;
  deleteJob(name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>;

  dropQueuedJobs(name: string): Promise<void>;
  dropStoredJobs(name: string): Promise<void>;
  dropAllJobs(name: string): Promise<void>;

  complete(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>;
  complete(name: string, id: string, data: object, options?: PgBoss.ConnectionOptions): Promise<void>;
  complete(name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>;

  fail(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>;
  fail(name: string, id: string, data: object, options?: PgBoss.ConnectionOptions): Promise<void>;
  fail(name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>;

  getJobById<T>(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<PgBoss.JobWithMetadata<T> | null>;

  createQueue(name: string, options?: PgBoss.Queue): Promise<void>;
  updateQueue(name: string, options?: PgBoss.Queue): Promise<void>;
  deleteQueue(name: string): Promise<void>;
  getQueues(): Promise<PgBoss.QueueResult[]>;
  getQueue(name: string): Promise<PgBoss.QueueResult | null>;
  getQueueSize(name: string, options?: { before: 'retry' | 'active' | 'completed' | 'cancelled' | 'failed' }): Promise<number>;

  maintain(): Promise<void>;
  maintain(name: string): Promise<void>;
  isInstalled(): Promise<Boolean>;
  schemaVersion(): Promise<Number>;

  schedule(name: string, cron: string, data?: object, options?: PgBoss.ScheduleOptions): Promise<void>;
  unschedule(name: string): Promise<void>;
  getSchedules(): Promise<PgBoss.Schedule[]>;
}

export = PgBoss;
