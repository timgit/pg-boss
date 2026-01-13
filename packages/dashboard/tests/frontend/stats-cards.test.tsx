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

  it("renders all stat cards", () => {
    render(<StatsCards stats={mockStats} />);

    expect(screen.getByText("Total Queued")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Deferred")).toBeInTheDocument();
    expect(screen.getByText("Total Jobs")).toBeInTheDocument();
  });

  it("displays the stat values", () => {
    render(<StatsCards stats={mockStats} />);

    // Check values are present (locale-independent check)
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    // Large numbers may have different formatting based on locale
    // Use a flexible regex that matches "1,000", "1.000", or "1000"
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

  it("renders stat cards with correct structure", () => {
    const { container } = render(<StatsCards stats={mockStats} />);

    // Check we have 4 stat cards
    const cards = container.querySelectorAll(".rounded-xl");
    expect(cards).toHaveLength(4);
  });
});
