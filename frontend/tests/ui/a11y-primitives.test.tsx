import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Stat } from "@/components/proto/bits";
import { Alert, AlertTitle } from "@/components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useReturnFocus } from "@/lib/use-return-focus";

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

function StateDrivenSheet() {
  const [open, setOpen] = useState(false);
  const returnFocus = useReturnFocus(open);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Agent Trace
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent onCloseAutoFocus={returnFocus}>
          <SheetTitle>Trace</SheetTitle>
          <SheetDescription>Runs</SheetDescription>
        </SheetContent>
      </Sheet>
    </>
  );
}

describe("useReturnFocus", () => {
  it("puts focus back on what opened a sheet without a trigger", async () => {
    render(<StateDrivenSheet />);
    const opener = screen.getByRole("button", { name: "Agent Trace" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog).toContainElement(document.activeElement as HTMLElement),
    );

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
  });
});

describe("Table", () => {
  it("leaves the scroll container alone by default", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>1</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const scroller = container.querySelector("[data-slot=table-container]");
    expect(scroller).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("makes a labelled, focusable scroll region with scrollLabel", () => {
    render(
      <Table scrollLabel="Your stakes, by site">
        <TableBody>
          <TableRow>
            <TableCell>1</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
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
