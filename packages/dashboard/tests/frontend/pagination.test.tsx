import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pagination } from "~/components/ui/pagination";

describe("Pagination", () => {
  it("returns null when no navigation needed", () => {
    const { container } = render(
      <Pagination
        page={1}
        hasNextPage={false}
        hasPrevPage={false}
        onPageChange={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("shows page info", () => {
    render(
      <Pagination
        page={3}
        totalPages={10}
        hasNextPage={true}
        hasPrevPage={true}
        onPageChange={vi.fn()}
      />
    );

    expect(screen.getByText("Page 3 of 10")).toBeInTheDocument();
  });

  it("shows page without total when totalPages is null", () => {
    render(
      <Pagination
        page={5}
        totalPages={null}
        hasNextPage={true}
        hasPrevPage={true}
        onPageChange={vi.fn()}
      />
    );

    expect(screen.getByText("Page 5")).toBeInTheDocument();
  });

  it("calls onPageChange with previous page", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();

    render(
      <Pagination
        page={3}
        hasNextPage={true}
        hasPrevPage={true}
        onPageChange={onPageChange}
      />
    );

    await user.click(screen.getByText("Previous"));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("calls onPageChange with next page", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();

    render(
      <Pagination
        page={3}
        hasNextPage={true}
        hasPrevPage={true}
        onPageChange={onPageChange}
      />
    );

    await user.click(screen.getByText("Next"));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it("disables Previous button when on first page", () => {
    render(
      <Pagination
        page={1}
        hasNextPage={true}
        hasPrevPage={false}
        onPageChange={vi.fn()}
      />
    );

    expect(screen.getByText("Previous").closest("button")).toBeDisabled();
    expect(screen.getByText("Next").closest("button")).not.toBeDisabled();
  });

  it("disables Next button when on last page", () => {
    render(
      <Pagination
        page={10}
        hasNextPage={false}
        hasPrevPage={true}
        onPageChange={vi.fn()}
      />
    );

    expect(screen.getByText("Previous").closest("button")).not.toBeDisabled();
    expect(screen.getByText("Next").closest("button")).toBeDisabled();
  });
});
