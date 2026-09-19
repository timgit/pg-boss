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
  /**
   * Origins a form submission may come from, e.g. `https://ops.example.com`.
   *
   * React Router refuses an action whose `Origin` header does not match the
   * request URL, which behind a proxy means every action returns 400 while every
   * page renders. `false` disables the check.
   */
  allowedActionOrigins?: string[] | false;
}

export interface DashboardHandler {
  (request: Request): Promise<Response>;
  /** Closes the database pools. Final: the handler cannot serve requests afterwards. */
  close (): Promise<void>;
}

export function createDashboardHandler (options: CreateDashboardHandlerOptions): DashboardHandler
