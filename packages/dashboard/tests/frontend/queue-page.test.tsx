import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueueConfig, QueueCounts } from "~/components/queue-page";
import type { QueueResult } from "~/lib/types";

// A line whose text matches, though its numbers are elements of their own.
const line = (re: RegExp) => (_: string, el: Element | null) =>
  Boolean(el && re.test(el.textContent ?? "") && ![...el.children].some((c) => re.test(c.textContent ?? "")));

// 22 queued: none ready, 15 deferred and 7 blocked, over a warning size of 5.
const queue = {
  name: "payments",
  policy: "standard",
  partition: false,
  deadLetter: "dead-letters",
  warningQueueSize: 5,
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: false,
  expireInSeconds: 900,
  retentionSeconds: 1_209_600,
  deleteAfterSeconds: 604_800,
  queuedCount: 22,
  deferredCount: 15,
  blockedCount: 7,
  readyCount: 0,
  activeCount: 0,
  failedCount: 0,
  totalCount: 22,
  readyHistory: null,
  createdOn: new Date(),
  updatedOn: new Date(),
  monitorOn: null,
  maintainOn: null,
} as unknown as QueueResult;

const inRouter = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

describe("QueueCounts", () => {
  it("leads with ready, active, failed and total, with queued and deferred as Ready's lines", () => {
    inRouter(<QueueCounts queue={queue} statsAvailable />);

    const counts = screen.getByRole("region", { name: "Counts" });
    expect(within(counts).getAllByRole("link").map((a) => a.textContent?.match(/^[A-Za-z ]+/)?.[0])).toEqual(["Ready", "Active", "Failed", "Total Jobs"]);
    expect(screen.getByText(line(/^of 22 queued, over its warning size of 5$/))).toBeInTheDocument();
    expect(screen.getByText(line(/^15 deferred for later · 7 blocked$/))).toBeInTheDocument();
    expect(screen.getByText("stored in this queue")).toBeInTheDocument();
  });

  it("says nothing of the warning size while the queue is under it", () => {
    inRouter(<QueueCounts queue={{ ...queue, queuedCount: 3, deferredCount: 0, blockedCount: 0, readyCount: 3 }} statsAvailable />);

    expect(screen.getByText(line(/^of 3 queued$/))).toBeInTheDocument();
    expect(screen.getByText("none deferred")).toBeInTheDocument();
  });
});

describe("QueueConfig", () => {
  it("lists only the settings the queue has", () => {
    inRouter(<QueueConfig queue={{ ...queue, deadLetter: undefined, warningQueueSize: 0, retryLimit: 0 }} />);

    expect(screen.getByText("Policy")).toBeInTheDocument();
    expect(screen.getByText("15 min")).toBeInTheDocument();
    expect(screen.queryByText("Dead letter queue")).not.toBeInTheDocument();
    expect(screen.queryByText("Warning size")).not.toBeInTheDocument();
    expect(screen.queryByText("Retries")).not.toBeInTheDocument();
    expect(screen.queryByText("Not set")).not.toBeInTheDocument();
  });

  it("says how a queue retries, and links its dead letter queue and subscriptions", () => {
    inRouter(<QueueConfig queue={{ ...queue, retryBackoff: true, retryDelayMax: 600 }} subscribedEvents={2} />);

    expect(screen.getByText("2, every 1 min, backing off to 10 min")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dead-letters" })).toHaveAttribute("href", "/queues/dead-letters");
    expect(screen.getByRole("link", { name: "2 events" })).toHaveAttribute("href", "/subscriptions?queue=payments");
  });
});
