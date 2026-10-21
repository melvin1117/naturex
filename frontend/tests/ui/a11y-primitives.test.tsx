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

function StateDrivenSheet({ modal = true }: { modal?: boolean }) {
  const [open, setOpen] = useState(false);
  const [showOpener, setShowOpener] = useState(true);
  const returnFocus = useReturnFocus(open);
  return (
    <>
      {showOpener && (
        <button type="button" onClick={() => setOpen(true)}>
          Agent Trace
        </button>
      )}
      {/* Like the tour's Next, outside the sheet: it closes the sheet from app state. */}
      <button type="button" onClick={() => setOpen(false)}>
        Next step
      </button>
      <Sheet modal={modal} open={open} onOpenChange={setOpen}>
        <SheetContent onCloseAutoFocus={returnFocus}>
          <SheetTitle>Trace</SheetTitle>
          <SheetDescription>Runs</SheetDescription>
          <button type="button" onClick={() => setShowOpener(false)}>
            Remove the opener
          </button>
        </SheetContent>
      </Sheet>
    </>
  );
}

async function openSheet(): Promise<HTMLElement> {
  const opener = screen.getByRole("button", { name: "Agent Trace" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(dialog).toContainElement(document.activeElement as HTMLElement),
  );
  return opener;
}

async function closed(): Promise<void> {
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  // Radix restores focus on a timer after the content unmounts.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("useReturnFocus", () => {
  it("puts focus back on what opened a sheet without a trigger", async () => {
    render(<StateDrivenSheet />);
    const opener = await openSheet();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    await closed();
    expect(opener).toHaveFocus();
  });

  it("leaves focus on a control outside a non-modal sheet", async () => {
    render(<StateDrivenSheet modal={false} />);
    await openSheet();
    const outside = screen.getByRole("button", { name: "Next step" });

    // A click outside: the control takes focus and closes the sheet.
    outside.focus();
    fireEvent.click(outside);

    await closed();
    expect(outside).toHaveFocus();
  });

  it("does nothing when the opener has left the page", async () => {
    render(<StateDrivenSheet />);
    await openSheet();
    fireEvent.click(screen.getByRole("button", { name: "Remove the opener" }));
    expect(
      screen.queryByRole("button", { name: "Agent Trace" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    await closed();
    expect(
      screen.queryByRole("button", { name: "Agent Trace" }),
    ).not.toBeInTheDocument();
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
