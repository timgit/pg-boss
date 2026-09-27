import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "~/components/ui/pagination";

function renderInRouter(ui: React.ReactNode, url = "/") {
  return render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);
}

describe("Pagination primitives", () => {
  it("is a labelled navigation landmark with a list inside", () => {
    renderInRouter(
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationLink to="/jobs?page=2">2</PaginationLink>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    );

    expect(screen.getByRole("navigation", { name: "pagination" })).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toBeInTheDocument();
  });

  it("marks the active page as the current one", () => {
    renderInRouter(<PaginationLink to="/jobs?page=3" isActive>3</PaginationLink>);

    const link = screen.getByRole("link", { name: "3" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveAttribute("data-active", "true");
  });

  it("links through the router, keeping the selected database", () => {
    // tests/setup.ts mocks useSearchParams, which is where DbLink reads the database from.
    vi.mocked(useSearchParams).mockReturnValueOnce([new URLSearchParams("db=orders"), vi.fn()]);
    renderInRouter(<PaginationLink to="/jobs?page=2">2</PaginationLink>, "/jobs?db=orders");

    expect(screen.getByRole("link", { name: "2" })).toHaveAttribute("href", "/jobs?page=2&db=orders");
  });

  it("renders a control with nowhere to go as disabled, not as a link", () => {
    renderInRouter(<PaginationPrevious />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Go to previous page")).toHaveAttribute("aria-disabled", "true");
  });

  it("labels Previous and Next for assistive technology", () => {
    renderInRouter(
      <>
        <PaginationPrevious to="/jobs" />
        <PaginationNext to="/jobs?page=3" />
      </>
    );

    expect(screen.getByRole("link", { name: "Go to previous page" })).toHaveAttribute("href", "/jobs");
    expect(screen.getByRole("link", { name: "Go to next page" })).toHaveAttribute("href", "/jobs?page=3");
  });

  it("gives the ellipsis a name only screen readers see", () => {
    renderInRouter(<PaginationEllipsis />);

    expect(screen.getByText("More pages")).toHaveClass("sr-only");
  });
});
