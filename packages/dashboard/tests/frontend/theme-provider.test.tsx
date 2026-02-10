import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ThemeProvider, useTheme, COLOR_THEMES } from "~/components/theme-provider";

// Helper component to access theme context
function ThemeConsumer() {
  const { theme, setTheme, resolvedTheme, colorTheme, setColorTheme } = useTheme();
  return (
    <div>
      <div data-testid="theme">{theme}</div>
      <div data-testid="resolved-theme">{resolvedTheme}</div>
      <div data-testid="color-theme">{colorTheme}</div>
      <button onClick={() => setTheme("dark")}>Set Dark</button>
      <button onClick={() => setTheme("light")}>Set Light</button>
      <button onClick={() => setTheme("system")}>Set System</button>
      <button onClick={() => setColorTheme("blue")}>Set Blue</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("provides theme context", () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId("theme")).toBeInTheDocument();
    expect(screen.getByTestId("resolved-theme")).toBeInTheDocument();
    expect(screen.getByTestId("color-theme")).toBeInTheDocument();
  });

  it("defaults to system theme", () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    const theme = screen.getByTestId("theme");
    expect(theme.textContent).toBe("system");
  });

  it("defaults to violet color theme", () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    const colorTheme = screen.getByTestId("color-theme");
    expect(colorTheme.textContent).toBe("violet");
  });

  it("allows changing theme to dark", async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    const button = screen.getByText("Set Dark");
    await act(async () => {
      button.click();
    });

    const theme = screen.getByTestId("theme");
    expect(theme.textContent).toBe("dark");
  });

  it("allows changing theme to light", async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    const button = screen.getByText("Set Light");
    await act(async () => {
      button.click();
    });

    const theme = screen.getByTestId("theme");
    expect(theme.textContent).toBe("light");
  });

  it("allows changing color theme", async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    const button = screen.getByText("Set Blue");
    await act(async () => {
      button.click();
    });

    const colorTheme = screen.getByTestId("color-theme");
    expect(colorTheme.textContent).toBe("blue");
  });

  it("exports COLOR_THEMES array", () => {
    expect(COLOR_THEMES).toBeInstanceOf(Array);
    expect(COLOR_THEMES.length).toBeGreaterThan(0);
    expect(COLOR_THEMES).toContain("violet");
    expect(COLOR_THEMES).toContain("blue");
  });

  it("throws error when useTheme is used outside provider", () => {
    const ConsoleError = console.error;
    console.error = () => {}; // Suppress error output in test

    expect(() => {
      render(<ThemeConsumer />);
    }).toThrow("useTheme must be used within a ThemeProvider");

    console.error = ConsoleError;
  });

  it("persists theme to localStorage", async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    const button = screen.getByText("Set Dark");
    await act(async () => {
      button.click();
    });

    expect(localStorage.getItem("pg-boss-theme")).toBe("dark");
  });

  it("persists color theme to localStorage", async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>
    );

    const button = screen.getByText("Set Blue");
    await act(async () => {
      button.click();
    });

    expect(localStorage.getItem("pg-boss-color-theme")).toBe("blue");
  });
});
