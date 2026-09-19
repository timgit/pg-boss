export interface DatabaseInput {
  url: string;
  /** Defaults to the database name in the connection string. */
  name?: string;
  /** Defaults to `pgboss`. */
  schema?: string;
}

export interface CreateDashboardHandlerOptions {
  /** The first one is selected by default. */
  databases: DatabaseInput[];
  /** Where the host mounts the handler, e.g. `/admin/queues`. Requests keep this prefix. */
  basePath?: string;
}

export interface DashboardHandler {
  (request: Request): Promise<Response>;
  /** Closes the database pools. Final: the handler cannot serve requests afterwards. */
  close (): Promise<void>;
}

export function createDashboardHandler (options: CreateDashboardHandlerOptions): DashboardHandler
