// Type definitions for pg-boss

declare namespace PgBoss {
  interface Db {
    executeSql(text: string, values: any[]): Promise<{ rows: any[]; rowCount: number }>;
  }

  interface DatabaseOptions {
    application_name?: string;
    database?: string;
    user?: string;
    password?: string;
    host?: string;
    port?: number;
    schema?: string;
    ssl?: boolean;
    connectionString?: string;
    poolSize?: number;
    max?: number;
    db?: Db;
  }

  interface QueueOptions {
    uuid?: "v1" | "v4";
    monitorStateIntervalSeconds?: number;
    monitorStateIntervalMinutes?: number;
  }

  interface MaintenanceOptions {
    noSupervisor?: boolean;

    archiveIntervalSeconds?: number;
    archiveIntervalMinutes?: number;
    archiveIntervalHours?: number;
    archiveIntervalDays?: number;

    deleteIntervalSeconds?: number;
    deleteIntervalMinutes?: number;
    deleteIntervalHours?: number;
    deleteIntervalDays?: number;

    maintenanceIntervalSeconds?: number;
    maintenanceIntervalMinutes?: number;
  }

  type ConstructorOptions =
    DatabaseOptions
      & QueueOptions
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

  type PublishOptions =
    JobOptions
      & ExpirationOptions
      & RetentionOptions
      & RetryOptions

  interface JobPollingOptions {
    newJobCheckInterval?: number;
    newJobCheckIntervalSeconds?: number;
  }

  interface JobFetchOptions {
    teamSize?: number;
    teamConcurrency?: number;
    batchSize?: number;
  }

  type SubscribeOptions = JobFetchOptions & JobPollingOptions

  interface SubscribeHandler<ReqData, ResData> {
    (job: PgBoss.JobWithDoneCallback<ReqData, ResData>, done: PgBoss.JobDoneCallback<ResData>): void;
  }

  interface Request {
    name: string;
    data?: object;
    options?: PublishOptions;
  }

  interface JobDoneCallback<T> {
    (err?: Error | null, data?: T): void;
  }

  interface Job<T = object> {
    id: string;
    name: string;
    data: T;
  }

  interface JobWithDoneCallback<ReqData, ResData> extends Job<ReqData> {
    done: JobDoneCallback<ResData>;
  }

  interface MonitorStates {
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
  connect(): Promise<PgBoss>;
  disconnect(): Promise<void>;

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
  subscribe<ReqData, ResData>(name: string, options: PgBoss.SubscribeOptions, handler: PgBoss.SubscribeHandler<ReqData, ResData>): Promise<void>;

  unsubscribe(name: string): Promise<boolean>;

  onComplete(name: string, handler: Function): Promise<void>;
  onComplete(name: string, options: PgBoss.SubscribeOptions, handler: Function): Promise<void>;

  offComplete(name: string): Promise<boolean>;

  fetch<T>(name: string): Promise<PgBoss.Job<T> | null>;
  fetch<T>(name: string, batchSize: number): Promise<PgBoss.Job<T>[] | null>;

  fetchCompleted<T>(name: string): Promise<PgBoss.Job<T> | null>;
  fetchCompleted<T>(name: string, batchSize: number): Promise<PgBoss.Job<T>[] | null>;

  cancel(id: string): Promise<void>;
  cancel(ids: string[]): Promise<void>;

  complete(id: string): Promise<void>;
  complete(id: string, data: object): Promise<void>;
  complete(ids: string[]): Promise<void>;

  fail(id: string): Promise<void>;
  fail(id: string, data: object): Promise<void>;
  fail(ids: string[]): Promise<void>;

  deleteQueue(name: string): Promise<void>;
  deleteAllQueues(): Promise<void>;

  archive(): Promise<void>;
  purge(): Promise<void>;
  expire(): Promise<void>;
}

export = PgBoss;
