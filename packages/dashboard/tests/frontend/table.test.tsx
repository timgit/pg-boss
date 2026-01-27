import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "~/components/ui/table";

describe("Table", () => {
  it("renders a table with header and body content", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Header</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Cell</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Header")).toBeInTheDocument();
    expect(screen.getByText("Cell")).toBeInTheDocument();
  });
});

describe("TableRow", () => {
  it("renders children", () => {
    render(
      <table>
        <tbody>
          <TableRow>
            <td>Row Content</td>
          </TableRow>
        </tbody>
      </table>
    );

    expect(screen.getByText("Row Content")).toBeInTheDocument();
  });

  it("calls onClick handler when clicked", () => {
    const handleClick = vi.fn();
    render(
      <table>
        <tbody>
          <TableRow onClick={handleClick}>
            <td>Clickable Row</td>
          </TableRow>
        </tbody>
      </table>
    );

    fireEvent.click(screen.getByRole("row"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});

describe("TableHead", () => {
  it("renders as a th element", () => {
    render(
      <table>
        <thead>
          <tr>
            <TableHead>Column Header</TableHead>
          </tr>
        </thead>
      </table>
    );

    expect(screen.getByRole("columnheader")).toHaveTextContent("Column Header");
  });
});

describe("TableCell", () => {
  it("renders as a td element", () => {
    render(
      <table>
        <tbody>
          <tr>
            <TableCell>Cell Content</TableCell>
          </tr>
        </tbody>
      </table>
    );

    expect(screen.getByRole("cell")).toHaveTextContent("Cell Content");
  });

  it("supports colSpan attribute", () => {
    render(
      <table>
        <tbody>
          <tr>
            <TableCell colSpan={3}>Spanning Cell</TableCell>
          </tr>
        </tbody>
      </table>
    );

    expect(screen.getByRole("cell")).toHaveAttribute("colspan", "3");
  });
});

describe("Table composition", () => {
  it("renders a complete data table", () => {
    const data = [
      { id: 1, name: "Alice", role: "Admin" },
      { id: 2, name: "Bob", role: "User" },
    ];

    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.id}</TableCell>
              <TableCell>{row.name}</TableCell>
              <TableCell>{row.role}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );

    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getAllByRole("row")).toHaveLength(3); // 1 header + 2 data
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });
});
