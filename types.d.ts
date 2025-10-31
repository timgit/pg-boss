import { EventEmitter } from 'events'

declare namespace PgBoss {

  type JobStates = {
    created: 'created',
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
    warningQueueSize?: number;
    superviseIntervalSeconds?: number;
    maintenanceIntervalSeconds?: number;
    queueCacheIntervalSeconds?: number;
    monitorIntervalSeconds?: number;
  }

  type ConstructorOptions = DatabaseOptions & SchedulingOptions & MaintenanceOptions

  interface QueueOptions {
    expireInSeconds?: number;
    retentionSeconds?: number;
    deleteAfterSeconds?: number;
    retryLimit?: number;
    retryDelay?: number;
    retryBackoff?: boolean;
    retryDelayMax?: number;
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

  type InsertOptions = ConnectionOptions

  type SendOptions = JobOptions & QueueOptions & ConnectionOptions

  type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive'

  type Queue = {
    name: string;
    policy?: QueuePolicy;
    partition?: boolean;
    deadLetter?: string;
    warningQueueSize?: number;
  } & QueueOptions

  type QueueResult = Queue & {
    deferredCount: number;
    queuedCount: number;
    activeCount: number;
    totalCount: number
    table: number;
    createdOn: Date;
    updatedOn: Date;
  }

  type ScheduleOptions = SendOptions & { tz?: string, key?: string }

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
  type FetchOptions = JobFetchOptions & ConnectionOptions

  interface WorkHandler<ReqData, ResData = any> {
    (job: PgBoss.Job<ReqData>[]): Promise<ResData>;
  }

  interface WorkWithMetadataHandler<ReqData, ResData = any> {
    (job: PgBoss.JobWithMetadata<ReqData>[]): Promise<ResData>;
  }

  interface Request {
    name: string;
    data?: object;
    options?: SendOptions;
  }

  interface Schedule {
    name: string;
    key: string;
    cron: string;
    timezone: string;
    data?: object;
    options?: SendOptions;
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
    retryDelayMax?: number;
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
    retryDelayMax?: number;
    startAfter?: Date | string;
    singletonKey?: string;
    singletonSeconds?: number;
    expireInSeconds?: number;
    deleteAfterSeconds?: number;
    retentionSeconds?: number;
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
  constructor (connectionString: string)
  constructor (options: PgBoss.ConstructorOptions)

  static getConstructionPlans (schema?: string): string
  static getMigrationPlans (schema?: string, version?: string): string
  static getRollbackPlans (schema?: string, version?: string): string

  static states: PgBoss.JobStates
  static policies: PgBoss.QueuePolicies

  on (event: 'error', handler: (error: Error) => void): this
  off (event: 'error', handler: (error: Error) => void): this

  on (event: 'warning', handler: (warning: { message: string, data: object }) => void): this
  off (event: 'warning', handler: (warning: { message: string, data: object }) => void): this

  on (event: 'wip', handler: (data: PgBoss.Worker[]) => void): this
  off (event: 'wip', handler: (data: PgBoss.Worker[]) => void): this

  on (event: 'stopped', handler: () => void): this
  off (event: 'stopped', handler: () => void): this

  start (): Promise<PgBoss>
  stop (options?: PgBoss.StopOptions): Promise<void>

  send (request: PgBoss.Request): Promise<string | null>
  send (name: string, data: object): Promise<string | null>
  send (name: string, data: object, options: PgBoss.SendOptions): Promise<string | null>

  sendAfter (name: string, data: object, options: PgBoss.SendOptions, date: Date): Promise<string | null>
  sendAfter (name: string, data: object, options: PgBoss.SendOptions, dateString: string): Promise<string | null>
  sendAfter (name: string, data: object, options: PgBoss.SendOptions, seconds: number): Promise<string | null>

  sendThrottled (name: string, data: object, options: PgBoss.SendOptions, seconds: number, key?: string): Promise<string | null>
  sendDebounced (name: string, data: object, options: PgBoss.SendOptions, seconds: number, key?: string): Promise<string | null>

  insert (name: string, jobs: PgBoss.JobInsert[]): Promise<void>
  insert (name: string, jobs: PgBoss.JobInsert[], options: PgBoss.InsertOptions): Promise<void>

  fetch<T>(name: string): Promise<PgBoss.Job<T>[]>
  fetch<T>(name: string, options: PgBoss.FetchOptions & { includeMetadata: true }): Promise<PgBoss.JobWithMetadata<T>[]>
  fetch<T>(name: string, options: PgBoss.FetchOptions): Promise<PgBoss.Job<T>[]>

  work<ReqData, ResData = any>(name: string, handler: PgBoss.WorkHandler<ReqData, ResData>): Promise<string>
  work<ReqData, ResData = any>(name: string, options: PgBoss.WorkOptions & { includeMetadata: true }, handler: PgBoss.WorkWithMetadataHandler<ReqData, ResData>): Promise<string>
  work<ReqData, ResData = any>(name: string, options: PgBoss.WorkOptions, handler: PgBoss.WorkHandler<ReqData, ResData>): Promise<string>

  offWork (name: string): Promise<void>
  offWork (options: PgBoss.OffWorkOptions): Promise<void>

  notifyWorker (workerId: string): void

  subscribe (event: string, name: string): Promise<void>
  unsubscribe (event: string, name: string): Promise<void>
  publish (event: string): Promise<void>
  publish (event: string, data: object): Promise<void>
  publish (event: string, data: object, options: PgBoss.SendOptions): Promise<void>

  cancel (name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>
  cancel (name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>

  resume (name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>
  resume (name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>

  retry (name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>
  retry (name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>

  deleteJob (name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>
  deleteJob (name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>
  deleteQueuedJobs (name: string): Promise<void>
  deleteStoredJobs (name: string): Promise<void>
  deleteAllJobs (name: string): Promise<void>

  complete (name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>
  complete (name: string, id: string, data: object, options?: PgBoss.ConnectionOptions): Promise<void>
  complete (name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>

  fail (name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<void>
  fail (name: string, id: string, data: object, options?: PgBoss.ConnectionOptions): Promise<void>
  fail (name: string, ids: string[], options?: PgBoss.ConnectionOptions): Promise<void>

  getJobById<T>(name: string, id: string, options?: PgBoss.ConnectionOptions): Promise<PgBoss.JobWithMetadata<T> | null>

  createQueue (name: string, options?: Omit<PgBoss.Queue, 'name'>): Promise<void>
  createQueue (options: PgBoss.Queue): Promise<void>
  updateQueue (name: string, options?: Omit<PgBoss.Queue, 'name', 'partition', 'policy'>): Promise<void>
  updateQueue (options: Omit<PgBoss.Queue, 'partition', 'policy'>): Promise<void>
  deleteQueue (name: string): Promise<void>
  getQueues (): Promise<PgBoss.QueueResult[]>
  getQueue (name: string): Promise<PgBoss.QueueResult | null>
  getQueueStats (name: string): Promise<PgBoss.QueueResult>

  supervise (name?: string): Promise<void>
  isInstalled (): Promise<boolean>
  schemaVersion (): Promise<number>

  schedule (name: string, cron: string, data?: object, options?: PgBoss.ScheduleOptions): Promise<void>
  unschedule (name: string, key?: string): Promise<void>
  getSchedules (name?: string, key?: string): Promise<PgBoss.Schedule[]>

  getDb (): PgBoss.Db
}

export = PgBoss
