import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsCards } from "~/components/stats-cards";
import type { AggregateStats } from "~/lib/types";

describe("StatsCards", () => {
  const mockStats: AggregateStats = {
    totalQueued: 150,
    totalActive: 25,
    totalDeferred: 50,
    totalJobs: 1000,
    queueCount: 5,
  };

  it("renders all stat labels", () => {
    render(<StatsCards stats={mockStats} />);

    expect(screen.getByText("Queued Jobs")).toBeInTheDocument();
    expect(screen.getByText("Active Jobs")).toBeInTheDocument();
    expect(screen.getByText("Deferred Jobs")).toBeInTheDocument();
    expect(screen.getByText("Total Jobs")).toBeInTheDocument();
  });

  it("displays stat values", () => {
    render(<StatsCards stats={mockStats} />);

    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    // Large numbers may have locale-specific formatting
    expect(screen.getByText(/1[,.\s]?000/)).toBeInTheDocument();
  });

  it("renders with zero values", () => {
    const emptyStats: AggregateStats = {
      totalQueued: 0,
      totalActive: 0,
      totalDeferred: 0,
      totalJobs: 0,
      queueCount: 0,
    };

    render(<StatsCards stats={emptyStats} />);

    const zeros = screen.getAllByText("0");
    expect(zeros).toHaveLength(4);
  });
});
