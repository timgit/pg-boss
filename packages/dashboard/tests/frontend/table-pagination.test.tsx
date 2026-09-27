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

const cursors = { nextCursor: "n1", prevCursor: "p1" };

describe("pageSlots", () => {
  it("offers the first page and the pages either side of this one", () => {
    expect(pageSlots(1, true, null)).toEqual([1, 2]);
    expect(pageSlots(2, true, null)).toEqual([1, 2, 3]);
    expect(pageSlots(3, false, null)).toEqual([1, 2, 3]);
  });

  it("marks the pages a cursor cannot reach with gaps", () => {
    expect(pageSlots(10, true, 20)).toEqual([1, "gap", 9, 10, 11, "gap"]);
    expect(pageSlots(10, true, 11)).toEqual([1, "gap", 9, 10, 11]);
    expect(pageSlots(10, true, null)).toEqual([1, "gap", 9, 10, 11]);
  });
});

describe("TablePagination", () => {
  it("renders nothing for a single page", () => {
    const { container } = renderAt("/queues", { page: 1, ...cursors, totalPages: 1, hasPrevPage: false, hasNextPage: false });

    expect(container).toBeEmptyDOMElement();
  });

  it("lists the pages around the current one, with ellipses", () => {
    renderAt("/queues?page=10&after=c", { page: 10, ...cursors, totalPages: 20, hasPrevPage: true, hasNextPage: true });

    expect(pageLabels()).toEqual(["1", "…", "9", "10", "11", "…"]);
    expect(screen.getByRole("link", { name: "10" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps every other search param and pages by cursor, dropping it for the first page", () => {
    renderAt("/queues?filter=attention&search=email&page=3&after=c", { page: 3, ...cursors, totalPages: 5, hasPrevPage: true, hasNextPage: true });

    expect(screen.getByRole("link", { name: "Go to next page" })).toHaveAttribute("href", "/queues?filter=attention&search=email&after=n1&page=4");
    expect(screen.getByRole("link", { name: "Go to previous page" })).toHaveAttribute("href", "/queues?filter=attention&search=email&before=p1&page=2");
    expect(screen.getByRole("link", { name: "1" })).toHaveAttribute("href", "/queues?filter=attention&search=email");
  });

  it("disables the end it is already at", () => {
    renderAt("/queues", { page: 1, ...cursors, totalPages: 3, hasPrevPage: false, hasNextPage: true });

    expect(screen.queryByRole("link", { name: "Go to previous page" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Go to previous page")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Go to next page" })).toBeInTheDocument();
  });

  it("leaves out the trailing gap when the total is unknown", () => {
    renderAt("/jobs?page=4&after=c", { page: 4, ...cursors, totalPages: null, hasPrevPage: true, hasNextPage: true });

    expect(pageLabels()).toEqual(["1", "…", "3", "4", "5"]);
  });

  it("labels the rows on screen when given a count and page size", () => {
    renderAt("/queues?page=2", { page: 2, ...cursors, totalPages: 7, hasPrevPage: true, hasNextPage: true, totalCount: 312, pageSize: 50 });

    expect(screen.getByText("51–100 of 312")).toBeInTheDocument();
  });

  it("says a page past the end holds none of the rows", () => {
    expect(rangeLabel(3, 20, 26)).toBe("0 of 26");
    expect(rangeLabel(2, 20, 26)).toBe("21–26 of 26");
  });

  it("ends the range at the count on the last page", () => {
    renderAt("/queues?page=7", { page: 7, ...cursors, totalPages: 7, hasPrevPage: true, hasNextPage: false, totalCount: 312, pageSize: 50 });

    expect(screen.getByText("301–312 of 312")).toBeInTheDocument();
  });
});
