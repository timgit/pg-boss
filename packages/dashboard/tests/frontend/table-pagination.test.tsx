import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { TablePagination, pageSlots, rangeLabel } from "~/components/table-pagination";

type Props = Parameters<typeof TablePagination>[0];

function renderAt(url: string, props: Props) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <TablePagination {...props} />
    </MemoryRouter>
  );
}

function pageLabels() {
  return within(screen.getByRole("list"))
    .getAllByRole("listitem")
    .map((item) => (item.textContent?.includes("More pages") ? "…" : item.textContent?.trim()))
    .slice(1, -1);
}

describe("pageSlots", () => {
  it("shows every page when there are few", () => {
    expect(pageSlots(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("keeps the ends and the neighbours, with gaps between", () => {
    expect(pageSlots(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
    expect(pageSlots(1, 20)).toEqual([1, 2, "gap", 20]);
    expect(pageSlots(20, 20)).toEqual([1, "gap", 19, 20]);
  });

  it("shows a single missing page rather than an ellipsis for it", () => {
    expect(pageSlots(4, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
  });
});

describe("TablePagination", () => {
  it("renders nothing for a single page", () => {
    const { container } = renderAt("/queues", { page: 1, totalPages: 1, hasPrevPage: false, hasNextPage: false });

    expect(container).toBeEmptyDOMElement();
  });

  it("lists the pages around the current one, with ellipses", () => {
    renderAt("/queues?page=10", { page: 10, totalPages: 20, hasPrevPage: true, hasNextPage: true });

    expect(pageLabels()).toEqual(["1", "…", "9", "10", "11", "…", "20"]);
    expect(screen.getByText("10")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "10" })).not.toBeInTheDocument();
  });

  it("keeps every other search param and drops page for the first page", () => {
    renderAt("/queues?filter=attention&search=email&page=2", { page: 2, totalPages: 3, hasPrevPage: true, hasNextPage: true });

    expect(screen.getByRole("link", { name: "Go to next page" })).toHaveAttribute("href", "/queues?filter=attention&search=email&page=3");
    expect(screen.getByRole("link", { name: "Go to previous page" })).toHaveAttribute("href", "/queues?filter=attention&search=email");
    expect(screen.getByRole("link", { name: "1" })).toHaveAttribute("href", "/queues?filter=attention&search=email");
  });

  it("disables the end it is already at", () => {
    renderAt("/queues", { page: 1, totalPages: 3, hasPrevPage: false, hasNextPage: true });

    expect(screen.queryByRole("link", { name: "Go to previous page" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Go to previous page")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Go to next page" })).toBeInTheDocument();
  });

  it("shows only the current page when the total is unknown", () => {
    renderAt("/jobs?page=4", { page: 4, totalPages: null, hasPrevPage: true, hasNextPage: true });

    expect(pageLabels()).toEqual(["4"]);
  });

  it("labels the rows on screen when given a count and page size", () => {
    renderAt("/queues?page=2", { page: 2, totalPages: 7, hasPrevPage: true, hasNextPage: true, totalCount: 312, pageSize: 50 });

    expect(screen.getByText("51–100 of 312")).toBeInTheDocument();
  });

  it("says a page past the end holds none of the rows", () => {
    expect(rangeLabel(3, 20, 26)).toBe("0 of 26");
    expect(rangeLabel(2, 20, 26)).toBe("21–26 of 26");
  });

  it("ends the range at the count on the last page", () => {
    renderAt("/queues?page=7", { page: 7, totalPages: 7, hasPrevPage: true, hasNextPage: false, totalCount: 312, pageSize: 50 });

    expect(screen.getByText("301–312 of 312")).toBeInTheDocument();
  });
});
