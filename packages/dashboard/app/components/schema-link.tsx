import { Link, useSearchParams } from "react-router";
import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";
import { resolveSchemaHref } from "~/lib/schema-href";

export { resolveSchemaHref };

type LinkProps = ComponentProps<typeof Link>;
type To = LinkProps["to"];

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
