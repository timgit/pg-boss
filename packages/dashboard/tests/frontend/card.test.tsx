import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "~/components/ui/card";

describe("Card", () => {
  it("renders children", () => {
    render(
      <Card>
        <div>Card Content</div>
      </Card>
    );
    expect(screen.getByText("Card Content")).toBeInTheDocument();
  });
});

describe("CardHeader", () => {
  it("renders children", () => {
    render(<CardHeader>Header Content</CardHeader>);
    expect(screen.getByText("Header Content")).toBeInTheDocument();
  });
});

describe("CardTitle", () => {
  it("renders as h3 heading", () => {
    render(<CardTitle>Title Text</CardTitle>);
    const title = screen.getByRole("heading", { level: 3 });
    expect(title).toHaveTextContent("Title Text");
  });
});

describe("CardDescription", () => {
  it("renders description text", () => {
    render(<CardDescription>Description text</CardDescription>);
    expect(screen.getByText("Description text")).toBeInTheDocument();
  });
});

describe("CardContent", () => {
  it("renders children", () => {
    render(<CardContent>Content Area</CardContent>);
    expect(screen.getByText("Content Area")).toBeInTheDocument();
  });
});

describe("Card composition", () => {
  it("renders full card structure", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Test Card</CardTitle>
          <CardDescription>Card subtitle</CardDescription>
        </CardHeader>
        <CardContent>
          <p>This is the card content.</p>
        </CardContent>
      </Card>
    );

    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Test Card");
    expect(screen.getByText("Card subtitle")).toBeInTheDocument();
    expect(screen.getByText("This is the card content.")).toBeInTheDocument();
  });
});
