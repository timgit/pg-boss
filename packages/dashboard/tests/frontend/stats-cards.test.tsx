import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsCards } from "~/components/stats-cards";
import type { QueueStats } from "~/lib/types";

// A line whose text matches, though its numbers are elements of their own.
const line = (re: RegExp) => (_: string, el: Element | null) =>
  Boolean(el && re.test(el.textContent ?? "") && ![...el.children].some((c) => re.test(c.textContent ?? "")));

describe("StatsCards", () => {
  // 150 queued: 100 ready, 40 deferred and 10 blocked. 1,000 stored: 818 of them finished.
  const mockStats: QueueStats = {
    totalQueued: 150,
    totalDeferred: 40,
    totalReady: 100,
    totalActive: 25,
    totalFailed: 7,
    totalJobs: 1000,
    queueCount: 5,
  };

  it("leads with ready, active, failed and total", () => {
    render(<StatsCards stats={mockStats} />);

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Total Jobs")).toBeInTheDocument();
    expect(screen.queryByText("Queued Jobs")).not.toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("says under Ready what else is queued, and under Total how many have finished", () => {
    render(<StatsCards stats={mockStats} />);

    expect(screen.getByText(line(/^of 150 queued$/))).toBeInTheDocument();
    expect(screen.getByText(line(/^40 deferred for later · 10 blocked$/))).toBeInTheDocument();
    expect(screen.getByText(line(/^818 completed or canceled$/))).toBeInTheDocument();
  });

  it("puts an overlay's line under the cell it names", () => {
    render(<StatsCards stats={mockStats} footers={{ totalActive: <span>on 2 live instances</span> }} />);

    expect(screen.getByText("on 2 live instances")).toBeInTheDocument();
  });

  it("renders with zero values, and says nothing is deferred or finished", () => {
    const emptyStats: QueueStats = {
      totalQueued: 0,
      totalDeferred: 0,
      totalReady: 0,
      totalActive: 0,
      totalFailed: 0,
      totalJobs: 0,
      queueCount: 0,
    };

    render(<StatsCards stats={emptyStats} />);

    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("none deferred")).toBeInTheDocument();
    expect(screen.queryByText(/completed or canceled/)).not.toBeInTheDocument();
  });
});
