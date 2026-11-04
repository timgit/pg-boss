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

  it("names the chosen option, and the null option when there is no filter", () => {
    const { rerender } = render(<FilterSelect value={null} options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("All");

    rerender(<FilterSelect value="active" options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("Active");
  });

  it("lists every option when opened", async () => {
    const user = userEvent.setup();
    render(<FilterSelect value={null} options={options} onChange={vi.fn()} />);

    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("option", { name: "Completed" })).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["All", "Active", "Completed"]);
  });

  it("calls onChange with the option picked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterSelect value={null} options={options} onChange={onChange} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Completed" }));
    expect(onChange).toHaveBeenCalledWith("completed");
  });

  it("calls onChange with null for the option that clears the filter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterSelect value="active" options={options} onChange={onChange} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "All" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
