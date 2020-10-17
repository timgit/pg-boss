declare namespace PgBoss {
  interface Db {
    executeSql(text: string, values: any[], options?: ExecutionOptions): Promise<{ rows: any[]; rowCount: number }>;
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

  interface QueueOptions {
    uuid?: "v1" | "v4";
    monitorStateIntervalSeconds?: number;
    monitorStateIntervalMinutes?: number;
  }

  interface SchedulingOptions {
    noScheduling?: boolean;

    clockMonitorIntervalSeconds?: number;
    clockMonitorIntervalMinutes?: number;
  }

  interface MaintenanceOptions {
    noSupervisor?: boolean;
    
    deleteAfterSeconds?: number;
    deleteAfterMinutes?: number;
    deleteAfterHours?: number;
    deleteAfterDays?: number;

    maintenanceIntervalSeconds?: number;
    maintenanceIntervalMinutes?: number;
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
    priority?: number;
    startAfter?: number | string | Date;
    singletonKey?: string;
    singletonSeconds?: number;
    singletonMinutes?: number;
    singletonHours?: number;
    singletonNextSlot?: boolean;
  }

  interface ExecutionOptions {
    connection?: any;
  }

  type PublishOptions = JobOptions & ExpirationOptions & RetentionOptions & RetryOptions & ExecutionOptions

  type ScheduleOptions = PublishOptions & { tz?: string }

  interface JobPollingOptions {
    newJobCheckInterval?: number;
    newJobCheckIntervalSeconds?: number;
  }

  interface JobFetchOptions {
    teamSize?: number;
    teamConcurrency?: number;
    batchSize?: number;
    includeMetadata?: boolean;
  }

  type SubscribeOptions = JobFetchOptions & JobPollingOptions

  type FetchOptions = {
    includeMetadata?: boolean;
  }

  interface SubscribeHandler<ReqData, ResData> {
    (job: PgBoss.JobWithDoneCallback<ReqData, ResData>): Promise<ResData> | void;
  }

  interface SubscribeWithMetadataHandler<ReqData, ResData> {
    (job: PgBoss.JobWithMetadataDoneCallback<ReqData, ResData>): Promise<ResData> | void;
  }

  interface Request {
    name: string;
    data?: object;
    options?: PublishOptions;
  }

  interface Schedule {
    name: string;
    cron: string;
    data?: object;
    options?: ScheduleOptions;
  }

  interface JobDoneCallback<T> {
    (err?: Error | null, data?: T): void;
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
  }

  interface JobWithMetadata<T = object> extends Job<T> {
    priority: number;
    state: 'created' | 'retry' | 'active' | 'completed' | 'expired' | 'cancelled' | 'failed';
    retrylimit: number;
    retrycount: number;
    retrydelay: number;
    retrybackoff: boolean;
    startafter: Date;
    // This is nullable in the schema, but by the time this type is reified,
    // it will have been set.
    startedon: Date;
    singletonkey: string | null;
    singletonon: Date | null;
    expirein: PostgresInterval;
    createdon: Date;
    completedon: Date | null;
    keepuntil: Date;
  }

  interface JobWithDoneCallback<ReqData, ResData> extends Job<ReqData> {
    done: JobDoneCallback<ResData>;
  }

  interface JobWithMetadataDoneCallback<ReqData, ResData> extends JobWithMetadata<ReqData> {
    done: JobDoneCallback<ResData>;
  }

  interface MonitorStates {
    all: number;
    created: number;
    retry: number;
    active: number;
    completed: number;
    expired: number;
    cancelled: number;
    failed: number;
    queues: object;
  }
}

declare class PgBoss {
  constructor(connectionString: string);
  constructor(options: PgBoss.ConstructorOptions);

  static getConstructionPlans(schema: string): string;
  static getMigrationPlans(schema: string, version: string): string;
  static getRollbackPlans(schema: string, version: string): string;

  on(event: "error", handler: (error: Error) => void): void;
  on(event: "archived", handler: (count: number) => void): void;
  on(event: "expired", handler: (count: number) => void): void;
  on(event: "maintenance", handler: () => void): void;
  on(event: "monitor-states", handler: (monitorStates: PgBoss.MonitorStates) => void): void;

  start(): Promise<PgBoss>;
  stop(): Promise<void>;

  publish(request: PgBoss.Request): Promise<string | null>;
  publish(name: string, data: object): Promise<string | null>;
  publish(name: string, data: object, options: PgBoss.PublishOptions): Promise<string | null>;

  publishAfter(name: string, data: object, options: PgBoss.PublishOptions, date: Date): Promise<string | null>;
  publishAfter(name: string, data: object, options: PgBoss.PublishOptions, dateString: string): Promise<string | null>;
  publishAfter(name: string, data: object, options: PgBoss.PublishOptions, seconds: number): Promise<string | null>;

  publishOnce(name: string, data: object, options: PgBoss.PublishOptions, key: string): Promise<string | null>;

  publishThrottled(name: string, data: object, options: PgBoss.PublishOptions, seconds: number): Promise<string | null>;
  publishThrottled(name: string, data: object, options: PgBoss.PublishOptions, seconds: number, key: string): Promise<string | null>;

  publishDebounced(name: string, data: object, options: PgBoss.PublishOptions, seconds: number): Promise<string | null>;
  publishDebounced(name: string, data: object, options: PgBoss.PublishOptions, seconds: number, key: string): Promise<string | null>;

  subscribe<ReqData, ResData>(name: string, handler: PgBoss.SubscribeHandler<ReqData, ResData>): Promise<void>;
  subscribe<ReqData, ResData>(name: string, options: PgBoss.SubscribeOptions & { includeMetadata: true }, handler: PgBoss.SubscribeWithMetadataHandler<ReqData, ResData>): Promise<void>;
  subscribe<ReqData, ResData>(name: string, options: PgBoss.SubscribeOptions, handler: PgBoss.SubscribeHandler<ReqData, ResData>): Promise<void>;

  unsubscribe(name: string): Promise<boolean>;

  onComplete(name: string, handler: Function): Promise<void>;
  onComplete(name: string, options: PgBoss.SubscribeOptions, handler: Function): Promise<void>;

  offComplete(name: string): Promise<boolean>;

  fetch<T>(name: string): Promise<PgBoss.Job<T> | null>;
  fetch<T>(name: string, batchSize: number): Promise<PgBoss.Job<T>[] | null>;
  fetch<T>(name: string, batchSize: number, options: PgBoss.FetchOptions & { includeMetadata: true }): Promise<PgBoss.JobWithMetadata<T>[] | null>;
  fetch<T>(name: string, batchSize: number, options: PgBoss.FetchOptions): Promise<PgBoss.Job<T>[] | null>;

  fetchCompleted<T>(name: string): Promise<PgBoss.Job<T> | null>;
  fetchCompleted<T>(name: string, batchSize: number): Promise<PgBoss.Job<T>[] | null>;
  fetchCompleted<T>(name: string, batchSize: number, options: PgBoss.FetchOptions & { includeMetadata: true }): Promise<PgBoss.JobWithMetadata<T>[] | null>;
  fetchCompleted<T>(name: string, batchSize: number, options: PgBoss.FetchOptions): Promise<PgBoss.Job<T>[] | null>;

  cancel(id: string): Promise<void>;
  cancel(ids: string[]): Promise<void>;

  complete(id: string): Promise<void>;
  complete(id: string, data: object): Promise<void>;
  complete(ids: string[]): Promise<void>;

  fail(id: string): Promise<void>;
  fail(id: string, data: object): Promise<void>;
  fail(ids: string[]): Promise<void>;

  getQueueSize(name: string, options?: object): Promise<number>;

  deleteQueue(name: string): Promise<void>;
  deleteAllQueues(): Promise<void>;
  clearStorage(): Promise<void>;

  archive(): Promise<void>;
  purge(): Promise<void>;
  expire(): Promise<void>;

  schedule(name: string, cron: string, data?: object, options?: PgBoss.ScheduleOptions): Promise<void>;
  unschedule(name: string): Promise<void>;
  getSchedules(): Promise<PgBoss.Schedule[]>;
}

export = PgBoss;
