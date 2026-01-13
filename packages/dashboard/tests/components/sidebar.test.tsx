import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Sidebar } from "~/components/layout/sidebar";

// Wrap component with router for NavLink to work
function renderWithRouter(initialRoute = "/") {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <Sidebar />
    </MemoryRouter>
  );
}

describe("Sidebar", () => {
  describe("desktop view", () => {
    it("renders navigation links", () => {
      renderWithRouter();

      expect(screen.getByText("Overview")).toBeInTheDocument();
      expect(screen.getByText("Queues")).toBeInTheDocument();
      expect(screen.getByText("Warnings")).toBeInTheDocument();
    });

    it("renders pg-boss branding", () => {
      renderWithRouter();

      // Should have pg-boss text in both mobile header and desktop sidebar
      const brandTexts = screen.getAllByText("pg-boss");
      expect(brandTexts.length).toBeGreaterThanOrEqual(1);
    });

    it("renders PG logo badge", () => {
      renderWithRouter();

      const logoTexts = screen.getAllByText("PG");
      expect(logoTexts.length).toBeGreaterThanOrEqual(1);
    });

    it("highlights active route - Overview", () => {
      renderWithRouter("/");

      // Find the Overview link
      const overviewLink = screen.getAllByText("Overview")[0].closest("a");
      expect(overviewLink).toHaveClass("bg-primary-50");
    });

    it("highlights active route - Queues", () => {
      renderWithRouter("/queues");

      const queuesLink = screen.getAllByText("Queues")[0].closest("a");
      expect(queuesLink).toHaveClass("bg-primary-50");
    });

    it("highlights active route - Warnings", () => {
      renderWithRouter("/warnings");

      const warningsLink = screen.getAllByText("Warnings")[0].closest("a");
      expect(warningsLink).toHaveClass("bg-primary-50");
    });
  });

  describe("mobile view", () => {
    it("renders mobile menu button", () => {
      renderWithRouter();

      // The mobile menu button should have "Open menu" screen reader text
      expect(screen.getByText("Open menu")).toBeInTheDocument();
    });

    it("opens mobile menu when button is clicked", () => {
      renderWithRouter();

      // Find and click the mobile menu button
      const openButton = screen.getByText("Open menu").closest("button")!;
      fireEvent.click(openButton);

      // Mobile menu should now show close button
      expect(screen.getByText("Close menu")).toBeInTheDocument();
    });

    it("closes mobile menu when close button is clicked", () => {
      renderWithRouter();

      // Open the menu
      const openButton = screen.getByText("Open menu").closest("button")!;
      fireEvent.click(openButton);

      // Close the menu
      const closeButton = screen.getByText("Close menu").closest("button")!;
      fireEvent.click(closeButton);

      // Close button should no longer be visible (menu closed)
      expect(screen.queryByText("Close menu")).not.toBeInTheDocument();
    });

    it("closes mobile menu when backdrop is clicked", () => {
      renderWithRouter();

      // Open the menu
      const openButton = screen.getByText("Open menu").closest("button")!;
      fireEvent.click(openButton);

      // Click the backdrop (the semi-transparent overlay)
      const backdrop = document.querySelector(".bg-gray-900\\/50");
      expect(backdrop).toBeInTheDocument();
      fireEvent.click(backdrop!);

      // Menu should be closed
      expect(screen.queryByText("Close menu")).not.toBeInTheDocument();
    });

    it("closes mobile menu when navigation link is clicked", () => {
      renderWithRouter();

      // Open the menu
      const openButton = screen.getByText("Open menu").closest("button")!;
      fireEvent.click(openButton);

      // Click a navigation link (in the mobile menu)
      // The mobile menu has its own set of nav links
      const mobileMenuLinks = document.querySelectorAll(".fixed.inset-y-0 a");
      expect(mobileMenuLinks.length).toBeGreaterThan(0);
      fireEvent.click(mobileMenuLinks[0]);

      // Menu should be closed
      expect(screen.queryByText("Close menu")).not.toBeInTheDocument();
    });
  });

  describe("navigation structure", () => {
    it("has correct hrefs for navigation links", () => {
      renderWithRouter();

      // Get all links - there will be duplicates for mobile/desktop
      const links = screen.getAllByRole("link");

      const hrefs = links.map((link) => link.getAttribute("href"));
      expect(hrefs).toContain("/");
      expect(hrefs).toContain("/queues");
      expect(hrefs).toContain("/warnings");
    });

    it("renders footer text", () => {
      renderWithRouter();

      expect(screen.getAllByText("pg-boss Dashboard").length).toBeGreaterThanOrEqual(1);
    });
  });
});
