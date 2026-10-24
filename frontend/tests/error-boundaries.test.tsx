import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AdminError from "@/app/admin/error";
import AppError from "@/app/error";
import { MAIN_ID } from "@/components/shell/skip-link";

describe("error boundaries", () => {
  it("says what happened, focuses the heading and retries", () => {
    const reset = vi.fn();
    render(<AppError error={new Error("internal detail")} reset={reset} />);
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Something went wrong",
    });
    expect(heading).toHaveFocus();
    // The error's own message never shows; without a digest there's no reference either.
    expect(screen.queryByText(/internal detail/)).toBeNull();
    expect(screen.queryByText(/Reference/)).toBeNull();
    expect(screen.getByRole("main")).toHaveAttribute("id", MAIN_ID);
    expect(
      screen.getByRole("link", { name: "Back to Rated sites" }),
    ).toHaveAttribute("href", "/");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("keeps the control room's main and links back to it", () => {
    const error = Object.assign(new Error("db password=x"), {
      digest: "2814452096",
    });
    render(<AdminError error={error} reset={vi.fn()} />);
    // The admin layout already renders the main landmark around it.
    expect(screen.queryByRole("main")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Back to the Time Machine" }),
    ).toHaveAttribute("href", "/admin");
    // A server error's digest is shown as an opaque reference; its message isn't.
    expect(screen.getByText("2814452096")).toBeInTheDocument();
    expect(screen.queryByText(/password/)).toBeNull();
  });
});
