import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ErrorCard } from "~/components/error-card";

describe("ErrorCard", () => {
  it("renders title and default message", () => {
    render(
      <MemoryRouter>
        <ErrorCard title="Something went wrong" />
      </MemoryRouter>
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Please check your database connection and try again.")).toBeInTheDocument();
  });

  it("renders custom message", () => {
    render(
      <MemoryRouter>
        <ErrorCard title="Error" message="Custom error message" />
      </MemoryRouter>
    );

    expect(screen.getByText("Custom error message")).toBeInTheDocument();
  });

  it("renders back link when provided", () => {
    render(
      <MemoryRouter>
        <ErrorCard
          title="Not Found"
          backTo={{ href: "/queues", label: "Back to Queues" }}
        />
      </MemoryRouter>
    );

    const link = screen.getByText("Back to Queues");
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute("href", "/queues");
  });

  it("does not render back link when not provided", () => {
    render(
      <MemoryRouter>
        <ErrorCard title="Error" />
      </MemoryRouter>
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
