import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeToggle } from "~/components/ui/theme-toggle";
import { useTheme } from "~/components/theme-provider";

vi.mock("~/components/theme-provider", () => ({
  useTheme: vi.fn(),
}));

describe("ThemeToggle", () => {
  const mockSetTheme = vi.fn();

  beforeEach(() => {
    mockSetTheme.mockClear();
    vi.mocked(useTheme).mockReturnValue({
      theme: "system",
      setTheme: mockSetTheme,
      resolvedTheme: "light",
    });
  });

  it("renders the toggle trigger", () => {
    render(<ThemeToggle />);

    expect(screen.getByLabelText("Toggle theme")).toBeInTheDocument();
  });

  // The trigger icon and label are driven by CSS from the html element's
  // class / data-theme-mode attribute (set by the inline theme script before
  // first paint), not by React state. This avoids a flash of the wrong icon on
  // load. So we assert the structural contract that makes that work rather than
  // a specific rendered string.
  it("renders both light and dark icons so CSS can pick without a flash", () => {
    const { container } = render(<ThemeToggle />);

    // Sun (light) and Moon (dark) are both present; CSS toggles visibility.
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    expect(container.querySelector(".dark\\:hidden")).toBeInTheDocument();
    expect(container.querySelector(".dark\\:block")).toBeInTheDocument();
  });

  it("renders the CSS-driven theme label placeholder", () => {
    const { container } = render(<ThemeToggle />);

    const label = container.querySelector(".theme-mode-label");
    expect(label).toBeInTheDocument();
    // Text is supplied by CSS ::after content, so the element itself is empty.
    expect(label?.textContent).toBe("");
  });
});
