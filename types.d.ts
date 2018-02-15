// Type definitions for pg-boss

declare namespace PgBoss {
  interface Db {
    executeSql(text: string, values: any[]): Promise<{ rows: any[]; rowCount: number }>;
  }

  interface ConnectionOptions {
    database?: string;
    user?: string;
    password?: string;
    host?: string;
    port?: number;
    schema?: string;
    uuid?: string;
    poolSize?: number;
    db?: Db;
  }

  interface PublishOptions {
    startIn?: number | string;
    singletonKey?: string;
    singletonSeconds?: number;
    singletonMinutes?: number;
    singletonHours?: number;
    singletonDays?: number;
    retryLimit?: number;
    expireIn?: string;
  }

  interface SubscribeOptions {
    teamSize?: number;
    batchSize?: number;
    newJobCheckInterval?: number;
    newJobCheckIntervalSeconds?: number;
  }

  interface Request {
    name: string;
    data?: object;
    options?: PublishOptions;
  }

  interface Job {
    id: number;
    name: string;
    data: object;
    done: (err?: Error, data?: object) => void;
  }
}

declare class PgBoss {
  constructor(connectionString: string);
  constructor(options: PgBoss.ConnectionOptions);

  on(event: string, handler: Function): void;
  start(): Promise<PgBoss>;
  stop(): Promise<void>;
  connect(): Promise<PgBoss>;
  disconnect(): Promise<void>;
  publish(request: PgBoss.Request): Promise<string | null>;
  publish(name: string, data: object): Promise<string | null>;
  publish(name: string, data: object, options: PgBoss.PublishOptions): Promise<string | null>;
  subscribe(name: string, handler: Function): Promise<void>;
  subscribe(name: string, options: PgBoss.SubscribeOptions, handler: Function): Promise<void>;
  onComplete(name: string, handler: Function): Promise<void>;
  onComplete(name: string, options: PgBoss.SubscribeOptions, handler: Function): Promise<void>;
  onFail(name: string, handler: Function): Promise<void>;
  onFail(name: string, options: PgBoss.SubscribeOptions, handler: Function): Promise<void>;
  unsubscribe(name: string): Promise<boolean>;
  offComplete(name: string): Promise<boolean>;
  offExpire(name: string): Promise<boolean>;
  offFail(name: string): Promise<boolean>;
  fetch(name: string): Promise<PgBoss.Job | null>;
  fetch(name: string, batchSize: number): Promise<PgBoss.Job | null>;
  fetchCompleted(name: string): Promise<PgBoss.Job | null>;
  fetchCompleted(name: string, batchSize: number): Promise<PgBoss.Job | null>;
  fetchExpired(name: string): Promise<PgBoss.Job | null>;
  fetchExpired(name: string, batchSize: number): Promise<PgBoss.Job | null>;
  fetchFailed(name: string): Promise<PgBoss.Job | null>;
  fetchFailed(name: string, batchSize: number): Promise<PgBoss.Job | null>;
  cancel(id: string): Promise<void>;
  cancel(ids: string[]): Promise<void>;
  complete(id: string): Promise<void>;
  complete(id: string, data: object): Promise<void>;
  complete(ids: string[]): Promise<void>;
  fail(id: string): Promise<void>;
  fail(id: string, data: object): Promise<void>;
  fail(ids: string[]): Promise<void>;
}

export = PgBoss;
