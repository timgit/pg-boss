import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "~/components/ui/badge";

describe("Badge", () => {
  it("renders children correctly", () => {
    render(<Badge>Test Badge</Badge>);
    expect(screen.getByText("Test Badge")).toBeInTheDocument();
  });

  it("applies variant classes for primary", () => {
    render(<Badge variant="primary">Primary</Badge>);
    expect(screen.getByText("Primary")).toHaveClass("bg-primary-50");
  });

  it("applies variant classes for success", () => {
    render(<Badge variant="success">Success</Badge>);
    expect(screen.getByText("Success")).toHaveClass("bg-success-50");
  });

  it("applies variant classes for warning", () => {
    render(<Badge variant="warning">Warning</Badge>);
    expect(screen.getByText("Warning")).toHaveClass("bg-warning-50");
  });

  it("applies variant classes for error", () => {
    render(<Badge variant="error">Error</Badge>);
    expect(screen.getByText("Error")).toHaveClass("bg-error-50");
  });

  it("applies variant classes for gray (default)", () => {
    render(<Badge variant="gray">Gray</Badge>);
    expect(screen.getByText("Gray")).toHaveClass("bg-gray-100");
  });

  it("applies small size classes", () => {
    render(<Badge size="sm">Small</Badge>);
    expect(screen.getByText("Small")).toHaveClass("text-xs");
  });

  it("applies medium size classes (default)", () => {
    render(<Badge size="md">Medium</Badge>);
    expect(screen.getByText("Medium")).toHaveClass("text-xs");
  });

  it("applies large size classes", () => {
    render(<Badge size="lg">Large</Badge>);
    expect(screen.getByText("Large")).toHaveClass("text-sm");
  });

  it("renders dot indicator when dot prop is true", () => {
    const { container } = render(<Badge dot>With Dot</Badge>);
    // The badge contains a nested span for the dot
    const spans = container.querySelectorAll("span");
    // Should have at least 2 spans: outer badge + dot
    expect(spans.length).toBeGreaterThanOrEqual(2);
  });

  it("does not render dot by default", () => {
    const { container } = render(<Badge>No Dot</Badge>);
    // Should only have 1 span (the outer badge)
    const spans = container.querySelectorAll("span > span");
    expect(spans.length).toBe(0);
  });

  it("defaults to gray variant and md size", () => {
    render(<Badge>Default</Badge>);
    const badge = screen.getByText("Default");
    expect(badge).toHaveClass("bg-gray-100");
    expect(badge).toHaveClass("text-xs");
  });
});
