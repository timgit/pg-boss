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

  it("renders whatever it was given as the trigger", () => {
    render(
      <ColorThemePicker>
        <span data-testid="mark" />
      </ColorThemePicker>
    );

    expect(screen.getByTestId("mark")).toBeInTheDocument();
  });

  // Unadvertised, not unlabelled: the trigger carries no visible text, so the
  // accessible name is the only thing naming it.
  it("names the trigger for assistive technology", () => {
    render(
      <ColorThemePicker>
        <span />
      </ColorThemePicker>
    );

    expect(screen.getByLabelText("Change color theme")).toBeInTheDocument();
  });

  // The swatch grid is the brand's oval, not a circle. It lives in the popup,
  // which only mounts once opened, so this asserts what the closed trigger is
  // *not*: a swatch of its own.
  it("shows no swatch or label of its own", () => {
    const { container } = render(
      <ColorThemePicker>
        <span data-testid="mark" />
      </ColorThemePicker>
    );

    expect(container.querySelector(".bg-primary-500")).not.toBeInTheDocument();
    expect(container.querySelector(".color-theme-label")).not.toBeInTheDocument();
  });
});
