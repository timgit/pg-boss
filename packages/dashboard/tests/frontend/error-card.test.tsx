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

  describe("with a thrown Response", () => {
    // React Router hands the boundary an ErrorResponse for a thrown `Response`; its
    // `data` is the body and `statusText` the reason line.
    function routeError(status: number, statusText: string, data: string) {
      return { status, statusText, data, internal: false };
    }

    it("shows the server's explanation instead of the database-connection copy", () => {
      render(
        <MemoryRouter>
          <ErrorCard
            title="Failed to load queue"
            error={routeError(403, "Read-only mode", "This dashboard is read-only (PGBOSS_DASHBOARD_READ_ONLY=1).")}
          />
        </MemoryRouter>
      );

      expect(screen.getByText("Read-only mode")).toBeInTheDocument();
      expect(
        screen.getByText("This dashboard is read-only (PGBOSS_DASHBOARD_READ_ONLY=1).")
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Please check your database connection and try again.")
      ).not.toBeInTheDocument();
    });

    it("surfaces a thrown 404's message too", () => {
      render(
        <MemoryRouter>
          <ErrorCard title="Failed to load queue" error={routeError(404, "", "Queue not found")} />
        </MemoryRouter>
      );

      // No reason line on the response, so the caller's heading stands.
      expect(screen.getByText("Failed to load queue")).toBeInTheDocument();
      expect(screen.getByText("Queue not found")).toBeInTheDocument();
    });

    it("keeps the caller's copy when the response carries no body", () => {
      render(
        <MemoryRouter>
          <ErrorCard title="Failed to load queue" error={routeError(500, "", "   ")} />
        </MemoryRouter>
      );

      expect(screen.getByText("Failed to load queue")).toBeInTheDocument();
      expect(
        screen.getByText("Please check your database connection and try again.")
      ).toBeInTheDocument();
    });

    it("ignores an ordinary Error, which has nothing worth showing a user", () => {
      render(
        <MemoryRouter>
          <ErrorCard title="Failed to load queue" error={new Error("connect ECONNREFUSED")} />
        </MemoryRouter>
      );

      expect(screen.getByText("Failed to load queue")).toBeInTheDocument();
      expect(
        screen.getByText("Please check your database connection and try again.")
      ).toBeInTheDocument();
      expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
    });
  });
});
