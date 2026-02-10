import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueueStatsCards } from "~/components/queue-stats-cards";

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return {
    ...actual,
    useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  };
});

describe("QueueStatsCards", () => {
  it("renders total queues count", () => {
    render(
      <MemoryRouter>
        <QueueStatsCards totalQueues={5} problemQueues={0} />
      </MemoryRouter>
    );

    expect(screen.getByText("Queues")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("formats large numbers with locale", () => {
    render(
      <MemoryRouter>
        <QueueStatsCards totalQueues={1234567} problemQueues={0} />
      </MemoryRouter>
    );

    expect(screen.getByText("1,234,567")).toBeInTheDocument();
  });

  it("renders link to queues page", () => {
    render(
      <MemoryRouter>
        <QueueStatsCards totalQueues={10} problemQueues={0} />
      </MemoryRouter>
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/queues");
  });

  it("does not render problem queues section when zero", () => {
    render(
      <MemoryRouter>
        <QueueStatsCards totalQueues={5} problemQueues={0} />
      </MemoryRouter>
    );

    expect(screen.queryByText("Needing Attention")).not.toBeInTheDocument();
  });

  it("renders problem queues section when greater than zero", () => {
    render(
      <MemoryRouter>
        <QueueStatsCards totalQueues={10} problemQueues={3} />
      </MemoryRouter>
    );

    expect(screen.getByText("Needing Attention")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("formats problem queues with locale", () => {
    render(
      <MemoryRouter>
        <QueueStatsCards totalQueues={10000} problemQueues={1234} />
      </MemoryRouter>
    );

    const problemCount = screen.getByText("1,234");
    expect(problemCount).toBeInTheDocument();
  });

  it("renders queue icon", () => {
    const { container } = render(
      <MemoryRouter>
        <QueueStatsCards totalQueues={5} problemQueues={0} />
      </MemoryRouter>
    );

    const queueIcon = container.querySelector('svg');
    expect(queueIcon).toBeInTheDocument();
  });

  it("renders warning icon when problem queues exist", () => {
    const { container } = render(
      <MemoryRouter>
        <QueueStatsCards totalQueues={10} problemQueues={5} />
      </MemoryRouter>
    );

    const icons = container.querySelectorAll('svg');
    expect(icons.length).toBeGreaterThan(1);
  });
});
