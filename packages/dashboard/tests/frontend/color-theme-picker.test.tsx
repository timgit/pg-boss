import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ColorThemePicker } from "~/components/ui/color-theme-picker";
import { useTheme } from "~/components/theme-provider";

vi.mock("~/components/theme-provider", () => ({
  useTheme: vi.fn(),
  COLOR_THEMES: ["emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple"],
}));

describe("ColorThemePicker", () => {
  const mockSetColorTheme = vi.fn();

  it("renders with current color theme", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "light",
      setTheme: vi.fn(),
      resolvedTheme: "light",
      colorTheme: "violet",
      setColorTheme: mockSetColorTheme,
    });

    render(<ColorThemePicker />);

    expect(screen.getByLabelText("Change color theme")).toBeInTheDocument();
    expect(screen.getByText("Violet")).toBeInTheDocument();
  });

  it("renders with different color themes", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "light",
      setTheme: vi.fn(),
      resolvedTheme: "light",
      colorTheme: "blue",
      setColorTheme: mockSetColorTheme,
    });

    render(<ColorThemePicker />);

    expect(screen.getByText("Blue")).toBeInTheDocument();
  });

  it("renders all color theme options", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "light",
      setTheme: vi.fn(),
      resolvedTheme: "light",
      colorTheme: "emerald",
      setColorTheme: mockSetColorTheme,
    });

    render(<ColorThemePicker />);

    expect(screen.getByText("Emerald")).toBeInTheDocument();
  });

  it("displays color swatch", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "light",
      setTheme: vi.fn(),
      resolvedTheme: "light",
      colorTheme: "teal",
      setColorTheme: mockSetColorTheme,
    });

    const { container } = render(<ColorThemePicker />);

    const swatch = container.querySelector('span.rounded-full');
    expect(swatch).toBeInTheDocument();
  });
});
