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
   * Hosts a form submission may come from, e.g. `ops.example.com`,
   * `ops.example.com:8443` or `*.example.com`.
   *
   * React Router refuses an action whose `Origin` header does not match the
   * request URL. Behind a proxy the host often sees `http://127.0.0.1:3000`
   * while the browser sent the public origin, so every action returns 400 while
   * every page renders — a failure that looks like a dashboard bug and is not.
   *
   * **Hosts, not origins.** `throwIfPotentialCSRFAttack` compares
   * `new URL(originHeader).host` against this list (react-router
   * `lib/actions.js:19,27`), so a scheme never matches: `https://ops.example.com`
   * is refused, `ops.example.com` is allowed. Wildcards are matched per label.
   *
   * There is no way to switch the check off. React Router coerces anything that
   * is not an array to `[]` before comparing, so a non-array value is the same
   * as omitting this.
   *
   * The usual place to set it is `react-router.config.ts`, which a host cannot
   * edit on a prebuilt package, leaving the handler as the only component that
   * can. Passing a `Request` carrying the public URL also works and needs no
   * configuration.
   */
  allowedActionOrigins?: string[];
}

export interface DashboardHandler {
  (request: Request): Promise<Response>;
  /** Closes the database pools. Final: the handler cannot serve requests afterwards. */
  close (): Promise<void>;
}

export function createDashboardHandler (options: CreateDashboardHandlerOptions): DashboardHandler
