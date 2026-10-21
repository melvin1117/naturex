import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Stat } from "@/components/proto/bits";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
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
