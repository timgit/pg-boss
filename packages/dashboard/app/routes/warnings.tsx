import { useSearchParams, Link } from "react-router";
import type { Route } from "./+types/warnings";
import { getWarnings, getWarningCount } from "~/lib/queries.server";
import { Card, CardHeader, CardTitle, CardContent } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "~/components/ui/table";
import type { WarningType } from "~/lib/types";
import { parsePageNumber, isValidWarningType, formatDateWithSeconds } from "~/lib/utils";

const WARNING_TYPE_OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: "All Types" },
  { value: "slow_query", label: "Slow Query" },
  { value: "queue_backlog", label: "Queue Backlog" },
  { value: "clock_skew", label: "Clock Skew" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const typeParam = url.searchParams.get("type");

  // Validate warning type filter - invalid values are treated as no filter
  const typeFilter = isValidWarningType(typeParam) ? typeParam : null;

  const page = parsePageNumber(url.searchParams.get("page"));
  const limit = 50;
  const offset = (page - 1) * limit;

  const [warnings, totalCount] = await Promise.all([
    getWarnings(context.DB_URL, context.SCHEMA, {
      type: typeFilter,
      limit,
      offset,
    }),
    getWarningCount(context.DB_URL, context.SCHEMA, typeFilter),
  ]);

  const totalPages = Math.ceil(totalCount / limit);

  return { warnings, totalCount, page, totalPages, typeFilter };
}

export function ErrorBoundary() {
  return (
    <div className="p-6">
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-error-600 font-medium">Failed to load warnings</p>
          <p className="text-gray-500 text-sm mt-1">
            Please check your database connection and try again.
          </p>
          <Link
            to="/"
            className="inline-block mt-4 text-primary-600 hover:text-primary-700"
          >
            Back to Dashboard
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Warnings({ loaderData }: Route.ComponentProps) {
  const { warnings, totalCount, page, totalPages, typeFilter } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const handleTypeChange = (value: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set("type", value);
    } else {
      params.delete("type");
    }
    params.delete("page");
    setSearchParams(params);
  };

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", newPage.toString());
    setSearchParams(params);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Warnings</h1>
        <p className="mt-1 text-sm text-gray-500">
          {totalCount.toLocaleString()} warning{totalCount !== 1 ? "s" : ""} recorded
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Warning History</CardTitle>
          <div className="flex items-center gap-2">
            <select
              value={typeFilter || ""}
              onChange={(e) => handleTypeChange(e.target.value || null)}
              className="px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
            >
              {WARNING_TYPE_OPTIONS.map((type) => (
                <option key={type.label} value={type.value || ""}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {warnings.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-gray-500 py-8" colSpan={4}>
                    {typeFilter
                      ? `No ${typeFilter.replace("_", " ")} warnings found`
                      : "No warnings recorded. Enable persistWarnings in pg-boss config to capture warnings."}
                  </TableCell>
                </TableRow>
              ) : (
                warnings.map((warning) => (
                  <TableRow key={warning.id}>
                    <TableCell>
                      <WarningTypeBadge type={warning.type} />
                    </TableCell>
                    <TableCell className="text-gray-900 max-w-md truncate">
                      {warning.message}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-gray-500 max-w-xs truncate">
                      {formatWarningData(warning.data)}
                    </TableCell>
                    <TableCell className="text-gray-500 whitespace-nowrap">
                      {formatDateWithSeconds(new Date(warning.createdOn))}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200">
            <div className="text-sm text-gray-500">
              Page {page} of {totalPages}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onPress={() => handlePageChange(page - 1)}
                isDisabled={page <= 1}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onPress={() => handlePageChange(page + 1)}
                isDisabled={page >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function WarningTypeBadge({ type }: { type: WarningType }) {
  const variants: Record<WarningType, "warning" | "error" | "gray"> = {
    slow_query: "warning",
    queue_backlog: "error",
    clock_skew: "gray",
  };

  const labels: Record<WarningType, string> = {
    slow_query: "Slow Query",
    queue_backlog: "Queue Backlog",
    clock_skew: "Clock Skew",
  };

  return (
    <Badge variant={variants[type]} size="sm">
      {labels[type]}
    </Badge>
  );
}

function formatWarningData(data: unknown): string {
  if (!data) return "-";
  if (typeof data === "string") return data;
  try {
    const obj = data as Record<string, unknown>;
    const parts: string[] = [];

    if (obj.elapsed) parts.push(`${(obj.elapsed as number).toFixed(2)}s`);
    if (obj.name) parts.push(`queue: ${obj.name}`);
    if (obj.queuedCount) parts.push(`queued: ${obj.queuedCount}`);
    if (obj.seconds) parts.push(`skew: ${(obj.seconds as number).toFixed(1)}s`);
    if (obj.direction) parts.push(`(${obj.direction})`);

    return parts.length > 0 ? parts.join(", ") : JSON.stringify(data);
  } catch {
    return String(data);
  }
}
