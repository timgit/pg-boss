import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ColorThemePicker } from "~/components/ui/color-theme-picker";
import { useTheme } from "~/components/theme-provider";

vi.mock("~/components/theme-provider", () => ({
  useTheme: vi.fn(),
  COLOR_THEMES: ["emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple"],
}));

describe("ColorThemePicker", () => {
  const mockSetColorTheme = vi.fn();

  beforeEach(() => {
    mockSetColorTheme.mockClear();
    vi.mocked(useTheme).mockReturnValue({
      theme: "light",
      setTheme: vi.fn(),
      resolvedTheme: "light",
      colorTheme: "violet",
      setColorTheme: mockSetColorTheme,
    });
  });

  it("renders the color picker trigger", () => {
    render(<ColorThemePicker />);

    expect(screen.getByLabelText("Change color theme")).toBeInTheDocument();
  });

  // The trigger swatch and label are driven by CSS from html[data-color-theme]
  // (set by the inline theme script before first paint), not by React state, so
  // they show the right color on load without a hydration flash.
  it("renders the swatch using the CSS primary color", () => {
    const { container } = render(<ColorThemePicker />);

    const swatch = container.querySelector("span.rounded-full");
    expect(swatch).toBeInTheDocument();
    expect(swatch).toHaveClass("bg-primary-500");
  });

  it("renders the CSS-driven color label placeholder", () => {
    const { container } = render(<ColorThemePicker />);

    const label = container.querySelector(".color-theme-label");
    expect(label).toBeInTheDocument();
    // Text is supplied by CSS ::after content, so the element itself is empty.
    expect(label?.textContent).toBe("");
  });
});
