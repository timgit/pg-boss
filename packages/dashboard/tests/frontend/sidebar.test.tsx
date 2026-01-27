import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Sidebar } from "~/components/layout/sidebar";

function renderWithRouter(initialRoute = "/") {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <Sidebar />
    </MemoryRouter>
  );
}

describe("Sidebar", () => {
  describe("navigation", () => {
    it("renders navigation links", () => {
      renderWithRouter();

      expect(screen.getByText("Overview")).toBeInTheDocument();
      expect(screen.getByText("Queues")).toBeInTheDocument();
      expect(screen.getByText("Warnings")).toBeInTheDocument();
    });

    it("has correct hrefs for navigation links", () => {
      renderWithRouter();

      const links = screen.getAllByRole("link");
      const hrefs = links.map((link) => link.getAttribute("href"));

      expect(hrefs).toContain("/");
      expect(hrefs).toContain("/queues");
      expect(hrefs).toContain("/warnings");
    });
  });

  describe("branding", () => {
    it("renders pg-boss branding", () => {
      renderWithRouter();

      const brandTexts = screen.getAllByText("pg-boss");
      expect(brandTexts.length).toBeGreaterThanOrEqual(1);
    });

    it("renders PG logo", () => {
      renderWithRouter();

      const logoTexts = screen.getAllByText("PG");
      expect(logoTexts.length).toBeGreaterThanOrEqual(1);
    });

    it("renders footer text", () => {
      renderWithRouter();

      expect(screen.getAllByText("pg-boss Dashboard").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("mobile menu", () => {
    it("renders mobile menu button", () => {
      renderWithRouter();

      expect(screen.getByText("Open menu")).toBeInTheDocument();
    });

    it("opens mobile menu when button is clicked", () => {
      renderWithRouter();

      const openButton = screen.getByText("Open menu").closest("button")!;
      fireEvent.click(openButton);

      expect(screen.getByText("Close menu")).toBeInTheDocument();
    });

    it("closes mobile menu when close button is clicked", () => {
      renderWithRouter();

      // Open
      fireEvent.click(screen.getByText("Open menu").closest("button")!);
      expect(screen.getByText("Close menu")).toBeInTheDocument();

      // Close
      fireEvent.click(screen.getByText("Close menu").closest("button")!);
      expect(screen.queryByText("Close menu")).not.toBeInTheDocument();
    });

    it("closes mobile menu when backdrop is clicked", () => {
      renderWithRouter();

      // Open
      fireEvent.click(screen.getByText("Open menu").closest("button")!);

      // Click backdrop
      const backdrop = document.querySelector("[class*='bg-gray-900']");
      expect(backdrop).toBeInTheDocument();
      fireEvent.click(backdrop!);

      expect(screen.queryByText("Close menu")).not.toBeInTheDocument();
    });

    it("closes mobile menu when navigation link is clicked", () => {
      renderWithRouter();

      // Open
      fireEvent.click(screen.getByText("Open menu").closest("button")!);

      // Click a nav link in the mobile menu
      const mobileMenuLinks = document.querySelectorAll(".fixed.inset-y-0 a");
      expect(mobileMenuLinks.length).toBeGreaterThan(0);
      fireEvent.click(mobileMenuLinks[0]);

      expect(screen.queryByText("Close menu")).not.toBeInTheDocument();
    });
  });
});
