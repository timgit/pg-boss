import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useMatches, useLocation } from "react-router";
import { Breadcrumbs } from "~/components/breadcrumbs";

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return {
    ...actual,
    useMatches: vi.fn(),
    useLocation: vi.fn(),
    useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  };
});

describe("Breadcrumbs", () => {
  it("returns null for root path", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    const { container } = render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders breadcrumbs for queues path", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/queues" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("Queues")).toBeInTheDocument();
  });

  it("renders breadcrumbs for specific queue", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/queues/my-queue" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("Queues")).toBeInTheDocument();
    expect(screen.getByText("my-queue")).toBeInTheDocument();
  });

  it("renders breadcrumbs for queue with encoded name", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/queues/my%20queue" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("my queue")).toBeInTheDocument();
  });

  it("renders breadcrumbs for job within queue", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/queues/my-queue/jobs/12345678-abcd" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("Queues")).toBeInTheDocument();
    expect(screen.getByText("my-queue")).toBeInTheDocument();
    expect(screen.getByText("12345678...")).toBeInTheDocument();
  });

  it("renders breadcrumbs for schedules path", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/schedules" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("Schedules")).toBeInTheDocument();
  });

  it("renders breadcrumbs for new schedule", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/schedules/new" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("Schedules")).toBeInTheDocument();
    expect(screen.getByText("New Schedule")).toBeInTheDocument();
  });

  it("renders breadcrumbs for specific schedule", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/schedules/my-schedule" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("Schedules")).toBeInTheDocument();
    expect(screen.getByText("my-schedule")).toBeInTheDocument();
  });

  it("renders breadcrumbs for jobs path", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/jobs" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("Jobs")).toBeInTheDocument();
  });

  it("renders breadcrumbs for warnings path", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/warnings" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("Warnings")).toBeInTheDocument();
  });

  it("renders breadcrumbs for send job path", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/send" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(screen.getByText("Queues")).toBeInTheDocument();
    expect(screen.getByText("Send Job")).toBeInTheDocument();
  });

  it("returns null for unknown path", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/unknown" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    const { container } = render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders separator between breadcrumbs", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/queues/my-queue" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    const separators = screen.getAllByText("/");
    expect(separators).toHaveLength(1);
  });

  it("renders last breadcrumb without link", () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: "/queues/my-queue" } as any);
    vi.mocked(useMatches).mockReturnValue([]);

    render(
      <MemoryRouter>
        <Breadcrumbs />
      </MemoryRouter>
    );

    const queueLink = screen.getByText("Queues").closest("a");
    expect(queueLink).toBeInTheDocument();

    const queueNameSpan = screen.getByText("my-queue");
    expect(queueNameSpan.tagName).toBe("SPAN");
  });
});
