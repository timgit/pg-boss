import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "~/components/ui/button";

describe("Button", () => {
  it("renders children correctly", () => {
    render(<Button>Click Me</Button>);
    expect(screen.getByRole("button")).toHaveTextContent("Click Me");
  });

  it("applies variant classes for primary (default)", () => {
    render(<Button variant="primary">Primary</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-primary-600");
  });

  it("applies variant classes for secondary", () => {
    render(<Button variant="secondary">Secondary</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-primary-50");
  });

  it("applies variant classes for outline", () => {
    render(<Button variant="outline">Outline</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-white", "border");
  });

  it("applies variant classes for ghost", () => {
    render(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByRole("button")).toHaveClass("hover:bg-gray-100");
  });

  it("applies variant classes for danger", () => {
    render(<Button variant="danger">Danger</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-error-600");
  });

  it("applies small size classes", () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole("button")).toHaveClass("text-sm");
  });

  it("applies medium size classes (default)", () => {
    render(<Button size="md">Medium</Button>);
    expect(screen.getByRole("button")).toHaveClass("text-sm");
  });

  it("applies large size classes", () => {
    render(<Button size="lg">Large</Button>);
    expect(screen.getByRole("button")).toHaveClass("text-base");
  });

  it("defaults to primary variant and md size", () => {
    render(<Button>Default</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("bg-primary-600");
    expect(button).toHaveClass("text-sm");
  });

  it("handles onPress events", async () => {
    const user = userEvent.setup();
    const handlePress = vi.fn();
    render(<Button onPress={handlePress}>Click</Button>);

    await user.click(screen.getByRole("button"));
    expect(handlePress).toHaveBeenCalledTimes(1);
  });

  it("can be disabled", async () => {
    const user = userEvent.setup();
    const handlePress = vi.fn();
    render(
      <Button isDisabled onPress={handlePress}>
        Disabled
      </Button>
    );

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();

    await user.click(button);
    expect(handlePress).not.toHaveBeenCalled();
  });

  it("merges custom className with default classes", () => {
    render(<Button className="custom-class">Button</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("custom-class");
    expect(button).toHaveClass("bg-primary-600");
  });

  it("supports type attribute for forms", () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });
});
