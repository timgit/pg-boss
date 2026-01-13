import { useFetcher, useSearchParams } from "react-router";
import { DbLink } from "~/components/db-link";
import type { Route } from "./+types/queues.$name";
import {
  getQueue,
  getJobs,
  getJobCountFromQueue,
  cancelJob,
  retryJob,
  deleteJob,
  isValidIntent,
} from "~/lib/queries.server";
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
import { Pagination } from "~/components/ui/pagination";
import { FilterSelect } from "~/components/ui/filter-select";
import { ErrorCard } from "~/components/error-card";
import type { JobState, JobResult } from "~/lib/types";
import {
  parsePageNumber,
  isValidJobState,
  formatDate,
  JOB_STATE_OPTIONS,
  JOB_STATE_VARIANTS,
} from "~/lib/utils";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");

  // Validate state filter - invalid values are treated as no filter
  const stateFilter = isValidJobState(stateParam) ? stateParam : null;

  const page = parsePageNumber(url.searchParams.get("page"));
  const limit = 50;
  const offset = (page - 1) * limit;

  const queue = await getQueue(context.DB_URL, context.SCHEMA, params.name);

  if (!queue) {
    throw new Response("Queue not found", { status: 404 });
  }

  const jobs = await getJobs(context.DB_URL, context.SCHEMA, params.name, {
    state: stateFilter,
    limit,
    offset,
  });

  // Use cached count from queue table instead of COUNT(*) query
  // Returns null if count not available for this filter
  const totalCount = getJobCountFromQueue(queue, stateFilter);
  const totalPages = totalCount !== null ? Math.ceil(totalCount / limit) : null;

  // Determine if there are more pages based on results
  const hasNextPage = jobs.length === limit;
  const hasPrevPage = page > 1;

  return {
    queue,
    jobs,
    totalCount,
    page,
    totalPages,
    stateFilter,
    hasNextPage,
    hasPrevPage,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");
  const jobId = formData.get("jobId") as string;

  if (!jobId || typeof jobId !== "string") {
    return { error: "Job ID is required", affected: 0 };
  }

  if (!isValidIntent(intent)) {
    return { error: "Invalid action", affected: 0 };
  }

  let affected = 0;
  let message = "";

  try {
    switch (intent) {
      case "cancel":
        affected = await cancelJob(context.DB_URL, context.SCHEMA, params.name, jobId);
        message = affected > 0
          ? "Job cancelled"
          : "Job could not be cancelled (may already be completed or cancelled)";
        break;
      case "retry":
        affected = await retryJob(context.DB_URL, context.SCHEMA, params.name, jobId);
        message = affected > 0
          ? "Job queued for retry"
          : "Job could not be retried (only failed jobs can be retried)";
        break;
      case "delete":
        affected = await deleteJob(context.DB_URL, context.SCHEMA, params.name, jobId);
        message = affected > 0
          ? "Job deleted"
          : "Job could not be deleted (may be active or already deleted)";
        break;
    }
  } catch (err) {
    return { error: "Database error occurred", affected: 0 };
  }

  return { success: affected > 0, affected, message };
}

export function ErrorBoundary() {
  return (
    <ErrorCard
      title="Failed to load queue"
      backTo={{ href: "/queues", label: "Back to Queues" }}
    />
  );
}

export default function QueueDetail({ loaderData }: Route.ComponentProps) {
  const {
    queue,
    jobs,
    totalCount,
    page,
    totalPages,
    stateFilter,
    hasNextPage,
    hasPrevPage,
  } = loaderData;
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
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <DbLink to="/queues" className="hover:text-gray-700">
          Queues
        </DbLink>
        <span>/</span>
        <span className="text-gray-900 font-medium">{queue.name}</span>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{queue.name}</h1>
          <div className="mt-2 flex items-center gap-3">
            <Badge variant="gray">{queue.policy}</Badge>
            {queue.partition && <Badge variant="primary">Partitioned</Badge>}
          </div>
        </div>
      </div>

      {/* Queue Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Queued" value={queue.queuedCount} variant="primary" />
        <StatCard label="Active" value={queue.activeCount} variant="success" />
        <StatCard label="Deferred" value={queue.deferredCount} variant="warning" />
        <StatCard label="Total" value={queue.totalCount} variant="gray" />
      </div>

      {/* Jobs Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            Jobs
            {totalCount !== null && ` (${totalCount.toLocaleString()})`}
          </CardTitle>
          <FilterSelect
            value={stateFilter}
            options={JOB_STATE_OPTIONS}
            onChange={(value) => handleFilterChange("state", value)}
          />
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Retries</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-gray-500 py-8" colSpan={6}>
                    No jobs found
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job: JobResult) => (
                  <JobRow key={job.id} job={job} queueName={queue.name} />
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        <Pagination
          page={page}
          totalPages={totalPages}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
          onPageChange={handlePageChange}
        />
      </Card>
    </div>
  );
}

function JobRow({
  job,
  queueName,
}: {
  job: JobResult;
  queueName: string;
}) {
  const fetcher = useFetcher<{ success?: boolean; affected?: number; message?: string; error?: string }>();
  const isLoading = fetcher.state !== "idle";

  // Show feedback after action completes
  const actionResult = fetcher.data;
  const showError = actionResult && !actionResult.success && actionResult.affected === 0;

  return (
    <TableRow>
      <TableCell className="font-mono text-xs text-gray-600">
        {job.id.slice(0, 8)}...
      </TableCell>
      <TableCell>
        <JobStateBadge state={job.state} />
      </TableCell>
      <TableCell className="text-gray-700">{job.priority}</TableCell>
      <TableCell className="text-gray-700">
        {job.retryCount} / {job.retryLimit}
      </TableCell>
      <TableCell className="text-gray-500">
        {formatDate(new Date(job.createdOn))}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {/* Show error message if action failed */}
          {showError && (
            <span className="text-xs text-warning-600" title={actionResult.message}>
              Action failed
            </span>
          )}
          {(job.state === "created" ||
            job.state === "retry" ||
            job.state === "active") && (
            <fetcher.Form method="post">
              <input type="hidden" name="jobId" value={job.id} />
              <input type="hidden" name="intent" value="cancel" />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                isDisabled={isLoading}
              >
                Cancel
              </Button>
            </fetcher.Form>
          )}
          {job.state === "failed" && (
            <fetcher.Form method="post">
              <input type="hidden" name="jobId" value={job.id} />
              <input type="hidden" name="intent" value="retry" />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                isDisabled={isLoading}
              >
                Retry
              </Button>
            </fetcher.Form>
          )}
          {/* Only show delete for non-active jobs */}
          {job.state !== "active" && (
            <fetcher.Form method="post">
              <input type="hidden" name="jobId" value={job.id} />
              <input type="hidden" name="intent" value="delete" />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                className="text-error-600 hover:text-error-700 hover:bg-error-50"
                isDisabled={isLoading}
              >
                Delete
              </Button>
            </fetcher.Form>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function JobStateBadge({ state }: { state: JobState }) {
  return (
    <Badge variant={JOB_STATE_VARIANTS[state]} size="sm">
      {state}
    </Badge>
  );
}

function StatCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: "primary" | "success" | "warning" | "gray";
}) {
  const colors = {
    primary: "text-primary-600",
    success: "text-success-600",
    warning: "text-warning-600",
    gray: "text-gray-600",
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold ${colors[variant]}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}
