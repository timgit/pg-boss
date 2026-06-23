import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsCards } from "~/components/stats-cards";
import type { QueueStats } from "~/lib/types";

describe("StatsCards", () => {
  const mockStats: QueueStats = {
    totalQueued: 150,
    totalDeferred: 50,
    totalReady: 100,
    totalActive: 25,
    totalFailed: 7,
    totalJobs: 1000,
    queueCount: 5,
  };

  it("renders all stat labels", () => {
    render(<StatsCards stats={mockStats} />);

    expect(screen.getByText("Queued Jobs")).toBeInTheDocument();
    expect(screen.getByText("Deferred")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Total Jobs")).toBeInTheDocument();
  });

  it("displays stat values", () => {
    render(<StatsCards stats={mockStats} />);

    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    // Large numbers may have locale-specific formatting
    expect(screen.getByText(/1[,.\s]?000/)).toBeInTheDocument();
  });

  it("renders with zero values", () => {
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

    const zeros = screen.getAllByText("0");
    expect(zeros).toHaveLength(6);
  });
});
