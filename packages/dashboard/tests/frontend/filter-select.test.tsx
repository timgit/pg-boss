import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterSelect } from "~/components/ui/filter-select";

describe("FilterSelect", () => {
  const options = [
    { value: null, label: "All" },
    { value: "active", label: "Active" },
    { value: "completed", label: "Completed" },
  ];

  it("renders all options", () => {
    render(
      <FilterSelect
        value={null}
        options={options}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("shows current value as selected", () => {
    render(
      <FilterSelect
        value="active"
        options={options}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("combobox")).toHaveValue("active");
  });

  it("calls onChange when selection changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <FilterSelect
        value={null}
        options={options}
        onChange={onChange}
      />
    );

    await user.selectOptions(screen.getByRole("combobox"), "completed");
    expect(onChange).toHaveBeenCalledWith("completed");
  });

  it("calls onChange with null when selecting empty value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <FilterSelect
        value="active"
        options={options}
        onChange={onChange}
      />
    );

    await user.selectOptions(screen.getByRole("combobox"), "");
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
