import Db from './db'

export interface BringYourOwnDatabase {
  db: Db
}

export type DatabaseOptions = ConstructorParameters<typeof Db>[0] | BringYourOwnDatabase

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
  manager: any
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
}

export interface RetentionOptions {
  retentionMinutes?: number
  retentionHours?: number
  retentionDays?: number
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
