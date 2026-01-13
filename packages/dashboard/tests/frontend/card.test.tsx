import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "~/components/ui/card";

describe("Card", () => {
  it("renders children correctly", () => {
    render(
      <Card>
        <div>Card Content</div>
      </Card>
    );
    expect(screen.getByText("Card Content")).toBeInTheDocument();
  });

  it("applies default styling classes", () => {
    render(<Card data-testid="card">Content</Card>);
    const card = screen.getByTestId("card");
    expect(card).toHaveClass("bg-white", "rounded-xl", "border", "shadow-sm");
  });

  it("merges custom className with default classes", () => {
    render(
      <Card className="custom-class" data-testid="card">
        Content
      </Card>
    );
    const card = screen.getByTestId("card");
    expect(card).toHaveClass("bg-white", "custom-class");
  });
});

describe("CardHeader", () => {
  it("renders children correctly", () => {
    render(<CardHeader>Header Content</CardHeader>);
    expect(screen.getByText("Header Content")).toBeInTheDocument();
  });

  it("applies padding classes", () => {
    render(<CardHeader data-testid="header">Content</CardHeader>);
    const header = screen.getByTestId("header");
    expect(header).toHaveClass("px-6", "py-5", "border-b");
  });
});

describe("CardTitle", () => {
  it("renders as h3 element", () => {
    render(<CardTitle>Title Text</CardTitle>);
    const title = screen.getByRole("heading", { level: 3 });
    expect(title).toHaveTextContent("Title Text");
  });

  it("applies typography classes", () => {
    render(<CardTitle>Title</CardTitle>);
    const title = screen.getByText("Title");
    expect(title).toHaveClass("text-lg", "font-semibold");
  });
});

describe("CardContent", () => {
  it("renders children correctly", () => {
    render(<CardContent>Content Area</CardContent>);
    expect(screen.getByText("Content Area")).toBeInTheDocument();
  });

  it("applies padding classes", () => {
    render(<CardContent data-testid="content">Content</CardContent>);
    const content = screen.getByTestId("content");
    expect(content).toHaveClass("px-6", "py-5");
  });
});

describe("Card composition", () => {
  it("renders full card structure correctly", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Test Card</CardTitle>
        </CardHeader>
        <CardContent>
          <p>This is the card content.</p>
        </CardContent>
      </Card>
    );

    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      "Test Card"
    );
    expect(
      screen.getByText("This is the card content.")
    ).toBeInTheDocument();
  });
});
