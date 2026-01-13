import { Link, useSearchParams } from "react-router";
import type { ComponentProps } from "react";

type LinkProps = ComponentProps<typeof Link>;

/**
 * A Link component that preserves the current database selection (db query param)
 * when navigating to other pages in the dashboard.
 */
export function DbLink({ to, children, ...props }: LinkProps) {
  const [searchParams] = useSearchParams();
  const dbParam = searchParams.get("db");

  // Build the target URL preserving the db param
  let href: string;
  if (typeof to === "string") {
    const url = new URL(to, "http://localhost");
    if (dbParam && !url.searchParams.has("db")) {
      url.searchParams.set("db", dbParam);
    }
    href = url.pathname + url.search;
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
    href = pathname + (search ? `?${search}` : "") + hash;
  } else {
    href = String(to);
  }

  return (
    <Link to={href} {...props}>
      {children}
    </Link>
  );
}
