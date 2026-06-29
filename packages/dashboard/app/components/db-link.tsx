import { Link, useSearchParams } from "react-router";
import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";

type LinkProps = ComponentProps<typeof Link>;
type To = LinkProps["to"];

// Resolve a router `to` into an href string that preserves the active database selection (the `db`
// query param). Pure so it can be reused by both DbLink and row-level navigation.
export function resolveDbHref(to: To, dbParam: string | null): string {
  if (typeof to === "string") {
    const url = new URL(to, "http://localhost");
    if (dbParam && !url.searchParams.has("db")) {
      url.searchParams.set("db", dbParam);
    }
    return url.pathname + url.search;
  } else if (typeof to === "object" && to !== null) {
    // Handle object form: { pathname, search, hash }
    const pathname = to.pathname || "";
    const existingSearch = to.search || "";
    const hash = to.hash || "";

    const params = new URLSearchParams(existingSearch.replace(/^\?/, ""));
    if (dbParam && !params.has("db")) {
      params.set("db", dbParam);
    }
    const search = params.toString();
    return pathname + (search ? `?${search}` : "") + hash;
  }
  return String(to);
}

// Hook form of resolveDbHref, reading the current db param from the URL.
export function useDbHref(to: To): string {
  const [searchParams] = useSearchParams();
  return resolveDbHref(to, searchParams.get("db"));
}

/**
 * A Link component that preserves the current database selection (db query param)
 * when navigating to other pages in the dashboard.
 */
export function DbLink({ to, children, className, ...props }: LinkProps) {
  const href = useDbHref(to);

  return (
    <Link to={href} className={cn("cursor-pointer", className)} {...props}>
      {children}
    </Link>
  );
}
