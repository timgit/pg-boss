import { Link, useSearchParams } from "react-router";
import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";

type LinkProps = ComponentProps<typeof Link>;
type To = LinkProps["to"];

// Resolve a router `to` into an href string that preserves the active schema selection (the `schema`
// query param). Pure so it can be reused by both SchemaLink and row-level navigation.
export function resolveSchemaHref(to: To, schemaParam: string | null): string {
  if (typeof to === "string") {
    const url = new URL(to, "http://localhost");
    if (schemaParam && !url.searchParams.has("schema")) {
      url.searchParams.set("schema", schemaParam);
    }
    return url.pathname + url.search + url.hash;
  } else if (typeof to === "object" && to !== null) {
    // Handle object form: { pathname, search, hash }
    const pathname = to.pathname || "";
    const existingSearch = to.search || "";
    const hash = to.hash || "";

    const params = new URLSearchParams(existingSearch.replace(/^\?/, ""));
    if (schemaParam && !params.has("schema")) {
      params.set("schema", schemaParam);
    }
    const search = params.toString();
    return pathname + (search ? `?${search}` : "") + hash;
  }
  return String(to);
}

// Hook form of resolveSchemaHref, reading the current schema param from the URL.
export function useSchemaHref(to: To): string {
  const [searchParams] = useSearchParams();
  return resolveSchemaHref(to, searchParams.get("schema"));
}

/**
 * A Link component that preserves the current schema selection (schema query param)
 * when navigating to other pages in the dashboard.
 */
export function SchemaLink({ to, children, className, ...props }: LinkProps) {
  const href = useSchemaHref(to);

  return (
    <Link to={href} className={cn("cursor-pointer", className)} {...props}>
      {children}
    </Link>
  );
}
