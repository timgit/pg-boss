import { useSearchParams } from "react-router";
import type { Route } from "./+types/warnings";
import { getWarnings, getWarningCount } from "~/lib/queries.server";
import { Card, CardHeader, CardTitle, CardContent } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "~/components/ui/table";
import { Pagination } from "~/components/ui/pagination";
import { FilterSelect } from "~/components/ui/filter-select";
import { ErrorCard } from "~/components/error-card";
import type { WarningType, WarningResult } from "~/lib/types";
import {
  parsePageNumber,
  isValidWarningType,
  formatDateWithSeconds,
  formatWarningData,
  WARNING_TYPE_OPTIONS,
  WARNING_TYPE_VARIANTS,
  WARNING_TYPE_LABELS,
} from "~/lib/utils";

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
    <ErrorCard
      title="Failed to load warnings"
      backTo={{ href: "/", label: "Back to Dashboard" }}
    />
  );
}

export default function Warnings({ loaderData }: Route.ComponentProps) {
  const { warnings, totalCount, page, totalPages, typeFilter } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const handleFilterChange = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
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
          <FilterSelect
            value={typeFilter}
            options={WARNING_TYPE_OPTIONS}
            onChange={(value) => handleFilterChange("type", value)}
          />
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
                warnings.map((warning: WarningResult) => (
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

        <Pagination
          page={page}
          totalPages={totalPages}
          hasNextPage={page < totalPages}
          hasPrevPage={page > 1}
          onPageChange={handlePageChange}
        />
      </Card>
    </div>
  );
}

function WarningTypeBadge({ type }: { type: WarningType }) {
  return (
    <Badge variant={WARNING_TYPE_VARIANTS[type]} size="sm">
      {WARNING_TYPE_LABELS[type]}
    </Badge>
  );
}
