import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useSearchParams } from "react-router";
import { SchemaLink } from "~/components/schema-link";

// Override the mock for specific tests
vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return {
    ...actual,
    useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  };
});

describe("SchemaLink", () => {
  beforeEach(() => {
    vi.mocked(useSearchParams).mockReturnValue([new URLSearchParams(), vi.fn()]);
  });

  it("renders link with children", () => {
    render(
      <MemoryRouter>
        <SchemaLink to="/queues">Go to Queues</SchemaLink>
      </MemoryRouter>
    );

    expect(screen.getByText("Go to Queues")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/queues");
  });

  it("preserves db param from current URL", () => {
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams("schema=production"),
      vi.fn(),
    ]);

    render(
      <MemoryRouter>
        <SchemaLink to="/queues">Queues</SchemaLink>
      </MemoryRouter>
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/queues?schema=production");
  });

  it("does not add db param if not present in current URL", () => {
    render(
      <MemoryRouter>
        <SchemaLink to="/warnings">Warnings</SchemaLink>
      </MemoryRouter>
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/warnings");
  });

  it("preserves existing query params in target URL", () => {
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams("schema=staging"),
      vi.fn(),
    ]);

    render(
      <MemoryRouter>
        <SchemaLink to="/queues?page=2">Page 2</SchemaLink>
      </MemoryRouter>
    );

    const href = screen.getByRole("link").getAttribute("href");
    expect(href).toContain("page=2");
    expect(href).toContain("schema=staging");
  });

  it("does not duplicate db param if already in target URL", () => {
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams("schema=production"),
      vi.fn(),
    ]);

    render(
      <MemoryRouter>
        <SchemaLink to="/queues?schema=other">Link</SchemaLink>
      </MemoryRouter>
    );

    // Should keep the target URL's db param, not add another
    expect(screen.getByRole("link")).toHaveAttribute("href", "/queues?schema=other");
  });

  it("keeps the target's hash after the db param", () => {
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams("schema=mydb"),
      vi.fn(),
    ]);

    render(
      <MemoryRouter>
        <SchemaLink to="/queues/q/metrics?total=1#active">Link</SchemaLink>
      </MemoryRouter>
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/queues/q/metrics?total=1&schema=mydb#active");
  });

  it("handles object form of to prop", () => {
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams("schema=mydb"),
      vi.fn(),
    ]);

    render(
      <MemoryRouter>
        <SchemaLink to={{ pathname: "/queues", search: "?state=active" }}>Link</SchemaLink>
      </MemoryRouter>
    );

    const href = screen.getByRole("link").getAttribute("href");
    expect(href).toContain("/queues");
    expect(href).toContain("state=active");
    expect(href).toContain("schema=mydb");
  });
});
