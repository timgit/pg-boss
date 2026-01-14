import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "~/components/ui/badge";

describe("Badge", () => {
  it("renders children", () => {
    render(<Badge>Test Badge</Badge>);
    expect(screen.getByText("Test Badge")).toBeInTheDocument();
  });

  it("renders with dot indicator when dot prop is true", () => {
    const { container } = render(<Badge dot>With Dot</Badge>);
    // The dot is a nested span element
    const dotElement = container.querySelector("span > span");
    expect(dotElement).toBeInTheDocument();
  });

  it("does not render dot by default", () => {
    const { container } = render(<Badge>No Dot</Badge>);
    const dotElement = container.querySelector("span > span");
    expect(dotElement).not.toBeInTheDocument();
  });
});
