import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Stat } from "@/components/proto/bits";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

describe("Stat", () => {
  it("is a term and its definitions, for use in a <dl>", () => {
    render(
      <dl>
        <Stat label="Sites listed" value={3} sub="all rated" />
      </dl>,
    );
    expect(screen.getByRole("term")).toHaveTextContent("Sites listed");
    expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual(
      ["3", "all rated"],
    );
  });
});

describe("Table", () => {
  const table = (scrollLabel?: string) => (
    <Table scrollLabel={scrollLabel}>
      <TableBody>
        <TableRow>
          <TableCell>1</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );

  /** jsdom has no layout: give every element these widths for the test. */
  function widths(scrollWidth: number, clientWidth: number) {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(
      scrollWidth,
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      clientWidth,
    );
  }

  afterEach(() => vi.restoreAllMocks());

  it("leaves the scroll container alone by default", () => {
    widths(900, 300);
    const { container } = render(table());
    const scroller = container.querySelector("[data-slot=table-container]");
    expect(scroller).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("adds no tab stop with scrollLabel while the table fits", () => {
    widths(300, 300);
    const { container } = render(table("Your stakes, by site"));
    expect(
      container.querySelector("[data-slot=table-container]"),
    ).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("makes a labelled, focusable scroll region while the table overflows", () => {
    widths(900, 300);
    render(table("Your stakes, by site"));
    const region = screen.getByRole("region", {
      name: "Your stakes, by site",
    });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toContainElement(screen.getByRole("table"));
  });
});

describe("AlertTitle", () => {
  it("wraps long titles instead of cutting them to one line", () => {
    render(
      <Alert>
        <AlertTitle>A long title that needs more than one line</AlertTitle>
      </Alert>,
    );
    expect(
      screen.getByText("A long title that needs more than one line"),
    ).not.toHaveClass("line-clamp-1");
  });
});

describe("TabsTrigger", () => {
  it("scrolls a tab into view when it takes focus", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const ledger = screen.getByRole("tab", { name: "Ledger" });
    ledger.focus();
    expect(scroll).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    expect(scroll.mock.contexts.at(-1)).toBe(ledger);
  });
});
