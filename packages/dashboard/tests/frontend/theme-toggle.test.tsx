import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeToggle } from "~/components/ui/theme-toggle";
import { useTheme } from "~/components/theme-provider";

vi.mock("~/components/theme-provider", () => ({
  useTheme: vi.fn(),
}));

describe("ThemeToggle", () => {
  const mockSetTheme = vi.fn();

  const mockTheme = (resolvedTheme: "light" | "dark", theme = resolvedTheme) => {
    vi.mocked(useTheme).mockReturnValue({
      theme,
      setTheme: mockSetTheme,
      resolvedTheme,
    });
  };

  beforeEach(() => {
    mockSetTheme.mockClear();
    mockTheme("light", "system");
  });

  it("renders the toggle", () => {
    render(<ThemeToggle />);

    expect(screen.getByLabelText("Toggle theme")).toBeInTheDocument();
  });

  // The icon is driven by CSS from the html element's class (set by the inline
  // theme script before first paint), not by React state. This avoids a flash
  // of the wrong icon on load. So we assert the structural contract that makes
  // that work rather than a specific rendered string.
  it("renders both light and dark icons so CSS can pick without a flash", () => {
    const { container } = render(<ThemeToggle />);

    expect(container.querySelectorAll("svg")).toHaveLength(2);
    expect(container.querySelector(".dark\\:hidden")).toBeInTheDocument();
    expect(container.querySelector(".dark\\:block")).toBeInTheDocument();
  });

  it("switches to dark when what is on screen is light", () => {
    mockTheme("light", "light");
    render(<ThemeToggle />);

    fireEvent.click(screen.getByLabelText("Toggle theme"));

    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("switches to light when what is on screen is dark", () => {
    mockTheme("dark", "dark");
    render(<ThemeToggle />);

    fireEvent.click(screen.getByLabelText("Toggle theme"));

    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  // The one case `theme` alone cannot answer: following the OS into dark is not
  // a theme you can toggle away from without knowing what it resolved to.
  it("leaves system-dark for light rather than for dark again", () => {
    mockTheme("dark", "system");
    render(<ThemeToggle />);

    fireEvent.click(screen.getByLabelText("Toggle theme"));

    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });
});
