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
   * Apply `PGBOSS_DASHBOARD_AUTH_*` inside the mount as well.
   *
   * Off by default: a handler is mounted behind the host's own authentication,
   * and prompting again for a second, unrelated credential is worse than not
   * prompting. Turn it on for defence in depth, or when the host has no
   * authentication of its own to put in front.
   *
   * Either way a configured credential is never discarded in silence — leaving
   * it off with `PGBOSS_DASHBOARD_AUTH_*` set says so on stdout, because an
   * operator who set a password and is not being asked for one needs to hear it
   * from us.
   */
  auth?: boolean;
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
   * `['**']` matches every host and so turns the check off completely. It is a
   * wildcard like any other — `matchWildcardDomain` returns true for any
   * non-empty domain once the pattern is down to `**` — and it is the wrong
   * answer to "actions return 400 behind my proxy": name the host. React Router
   * coerces a non-array value to `[]`, so passing `false` disables nothing.
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
  /**
   * Releases everything this handler holds: the database pools and the pg-boss
   * instances behind the write paths, whose timers otherwise keep the event
   * loop alive.
   *
   * Final. Requests after it answer 503 rather than reopening what was closed.
   */
  close (): Promise<void>;
}

export function createDashboardHandler (options: CreateDashboardHandlerOptions): DashboardHandler
