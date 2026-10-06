import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  ListRow,
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

describe("TableRow navigation (`to`)", () => {
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navigate = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(navigate);
  });

  const renderRow = (children: React.ReactNode) =>
    render(
      <table>
        <tbody>
          <TableRow to="/queues/abc">{children}</TableRow>
        </tbody>
      </table>
    );

  it("marks the row clickable and navigates on a plain-cell click", () => {
    renderRow(<td>plain cell</td>);
    expect(screen.getByRole("row")).toHaveClass("cursor-pointer");

    fireEvent.click(screen.getByText("plain cell"));
    expect(navigate).toHaveBeenCalledWith("/queues/abc");
  });

  it("defers to nested interactive elements instead of navigating", () => {
    renderRow(
      <td>
        <a href="/other">inner link</a>
        <button>inner button</button>
      </td>
    );

    fireEvent.click(screen.getByText("inner link"));
    fireEvent.click(screen.getByText("inner button"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores a click in a menu the row opened, which reaches it through a portal", () => {
    renderRow(<td>{createPortal(<div>menu padding</div>, document.body)}</td>);

    fireEvent.click(screen.getByText("menu padding"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores modifier-clicks so the primary link can open in a new tab", () => {
    renderRow(<td>plain cell</td>);
    fireEvent.click(screen.getByText("plain cell"), { metaKey: true });
    fireEvent.click(screen.getByText("plain cell"), { ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("runs a row's own click only when the click is not on something that handles its own", () => {
    const toggle = vi.fn();
    render(
      <table>
        <tbody>
          <TableRow onClick={toggle}>
            <td>plain cell</td>
            <td><button onClick={toggle}>expander</button></td>
          </TableRow>
        </tbody>
      </table>
    );

    fireEvent.click(screen.getByText("plain cell"));
    fireEvent.click(screen.getByText("expander"));
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it("makes a list item a clickable row too", () => {
    render(
      <ul>
        <ListRow to="/pro/accounts/1">
          <span>Sam</span>
          <button>Remove</button>
        </ListRow>
      </ul>
    );

    fireEvent.click(screen.getByText("Remove"));
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Sam"));
    expect(navigate).toHaveBeenCalledWith("/pro/accounts/1");
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
