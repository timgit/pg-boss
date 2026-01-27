import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useSearchParams } from "react-router";
import { DbLink } from "~/components/db-link";

// Override the mock for specific tests
vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return {
    ...actual,
    useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  };
});

describe("DbLink", () => {
  beforeEach(() => {
    vi.mocked(useSearchParams).mockReturnValue([new URLSearchParams(), vi.fn()]);
  });

  it("renders link with children", () => {
    render(
      <MemoryRouter>
        <DbLink to="/queues">Go to Queues</DbLink>
      </MemoryRouter>
    );

    expect(screen.getByText("Go to Queues")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/queues");
  });

  it("preserves db param from current URL", () => {
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams("db=production"),
      vi.fn(),
    ]);

    render(
      <MemoryRouter>
        <DbLink to="/queues">Queues</DbLink>
      </MemoryRouter>
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/queues?db=production");
  });

  it("does not add db param if not present in current URL", () => {
    render(
      <MemoryRouter>
        <DbLink to="/warnings">Warnings</DbLink>
      </MemoryRouter>
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/warnings");
  });

  it("preserves existing query params in target URL", () => {
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams("db=staging"),
      vi.fn(),
    ]);

    render(
      <MemoryRouter>
        <DbLink to="/queues?page=2">Page 2</DbLink>
      </MemoryRouter>
    );

    const href = screen.getByRole("link").getAttribute("href");
    expect(href).toContain("page=2");
    expect(href).toContain("db=staging");
  });

  it("does not duplicate db param if already in target URL", () => {
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams("db=production"),
      vi.fn(),
    ]);

    render(
      <MemoryRouter>
        <DbLink to="/queues?db=other">Link</DbLink>
      </MemoryRouter>
    );

    // Should keep the target URL's db param, not add another
    expect(screen.getByRole("link")).toHaveAttribute("href", "/queues?db=other");
  });

  it("handles object form of to prop", () => {
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams("db=mydb"),
      vi.fn(),
    ]);

    render(
      <MemoryRouter>
        <DbLink to={{ pathname: "/queues", search: "?state=active" }}>Link</DbLink>
      </MemoryRouter>
    );

    const href = screen.getByRole("link").getAttribute("href");
    expect(href).toContain("/queues");
    expect(href).toContain("state=active");
    expect(href).toContain("db=mydb");
  });
});
