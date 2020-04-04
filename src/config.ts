import { PoolConfig, Defaults } from 'pg'

export interface DbConfig extends PoolConfig, Defaults {
  db: never
}

export interface BringYourOwnDatabaseInterface {
  executeSql(text: string, values: any[]): Promise<{ rows: any[], rowCount: number }>
}

export interface BringYourOwnDatabaseConfig {
  db: BringYourOwnDatabaseInterface
}

interface DbSchemaConfig {
  schema?: string
}

export type DatabaseOptions = DbSchemaConfig & (DbConfig | BringYourOwnDatabaseConfig)

const dop: DatabaseOptions = {
  application_name: 'a',
  connectionString: 'a',
  db: {
    executeSql: (text, values) => {
      return Promise.resolve({
        rows: [],
        rowCount: 1
      })
    }
  }
}
console.log(dop)

export interface QueueOptions {
  uuid?: 'v1' | 'v4'
  monitorStateIntervalSeconds?: number
  monitorStateIntervalMinutes?: number
}

export interface MaintenanceOptions {
  noSupervisor?: boolean

  archiveIntervalSeconds?: number
  archiveIntervalMinutes?: number
  archiveIntervalHours?: number
  archiveIntervalDays?: number
  archiveInterval: string // interval

  deleteIntervalSeconds?: number
  deleteIntervalMinutes?: number
  deleteIntervalHours?: number
  deleteIntervalDays?: number
  deleteInterval: string

  maintenanceIntervalSeconds?: number
  maintenanceIntervalMinutes?: number

}

// TODO: add correct type
export interface Manager {
  manager?: any
}

export type BossConfig =
  DatabaseOptions
  & QueueOptions
  & MaintenanceOptions
  & ExpirationOptions
  & RetentionOptions
  & RetryOptions
  & JobPollingOptions
  & Manager

export interface ExpirationOptions {
  expireInSeconds?: number
  expireInMinutes?: number
  expireInHours?: number

  /**
   * @deprecated
  */
  expireIn?: number | string
}

export interface RetentionOptions {
  retentionSeconds?: number
  retentionMinutes?: number
  retentionHours?: number
  retentionDays?: number
  keepUntil?: string
}

export interface RetryOptions {
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
}

export interface JobPollingOptions {
  newJobCheckInterval?: number
  newJobCheckIntervalSeconds?: number
}

export interface Job<T = object> {
  id: string
  name: string
  data: T
}

export interface JobWithDoneCallback<T = object> extends Job<T> {
  done: (error: Error, response: object) => Promise<void>
}

export interface WorkerConfig {
  name: string
  interval: number
  fetch: () => Promise<JobWithDoneCallback | JobWithDoneCallback[]>
  onFetch: (jobs: JobWithDoneCallback[]) => Promise<any>
  onError: (err: Error) => any
}
