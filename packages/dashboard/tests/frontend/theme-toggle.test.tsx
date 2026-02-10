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
  });

  it("renders with light theme", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "light",
      setTheme: mockSetTheme,
      resolvedTheme: "light",
    });

    render(<ThemeToggle />);

    expect(screen.getByText("Light")).toBeInTheDocument();
    expect(screen.getByLabelText("Toggle theme")).toBeInTheDocument();
  });

  it("renders with dark theme", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "dark",
      setTheme: mockSetTheme,
      resolvedTheme: "dark",
    });

    render(<ThemeToggle />);

    expect(screen.getByText("Dark")).toBeInTheDocument();
  });

  it("renders with system theme", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "system",
      setTheme: mockSetTheme,
      resolvedTheme: "light",
    });

    render(<ThemeToggle />);

    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("renders icon for light resolved theme", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "light",
      setTheme: mockSetTheme,
      resolvedTheme: "light",
    });

    const { container } = render(<ThemeToggle />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it("renders icon for dark resolved theme", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "dark",
      setTheme: mockSetTheme,
      resolvedTheme: "dark",
    });

    const { container } = render(<ThemeToggle />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it("renders with system theme but light resolved", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "system",
      setTheme: mockSetTheme,
      resolvedTheme: "light",
    });

    const { container } = render(<ThemeToggle />);

    expect(screen.getByText("System")).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it("renders with system theme but dark resolved", () => {
    vi.mocked(useTheme).mockReturnValue({
      theme: "system",
      setTheme: mockSetTheme,
      resolvedTheme: "dark",
    });

    const { container } = render(<ThemeToggle />);

    expect(screen.getByText("System")).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
