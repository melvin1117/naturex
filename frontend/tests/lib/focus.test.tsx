import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { focusIfLost, useRestoreFocusAfterPending } from "@/lib/focus";

afterEach(() => {
  document.body.innerHTML = "";
});

function region() {
  const el = document.createElement("section");
  el.tabIndex = -1;
  document.body.append(el);
  return el;
}

describe("focusIfLost (T48)", () => {
  it("takes focus that fell back to the page", () => {
    const target = region();
    focusIfLost(target);
    expect(document.activeElement).toBe(target);
  });

  it("never pulls focus from where the person is", () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    focusIfLost(region());
    expect(document.activeElement).toBe(field);
  });

  it("ignores a target that isn't there", () => {
    expect(() => focusIfLost(null)).not.toThrow();
  });
});

function Upload({ pending }: { pending: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useRestoreFocusAfterPending(pending, ref);
  return (
    <button ref={ref} disabled={pending}>
      Upload
    </button>
  );
}

describe("useRestoreFocusAfterPending (T48)", () => {
  it("gives focus back once the request ends, not before", () => {
    const { getByRole, rerender } = render(<Upload pending={false} />);
    const button = getByRole("button");
    expect(button).not.toHaveFocus();
    rerender(<Upload pending />);
    expect(button).not.toHaveFocus();
    rerender(<Upload pending={false} />);
    expect(button).toHaveFocus();
  });

  it("leaves focus alone if the person moved on meanwhile", () => {
    const { getByRole, rerender } = render(
      <>
        <Upload pending />
        <input aria-label="elsewhere" />
      </>,
    );
    const elsewhere = getByRole("textbox");
    elsewhere.focus();
    rerender(
      <>
        <Upload pending={false} />
        <input aria-label="elsewhere" />
      </>,
    );
    expect(elsewhere).toHaveFocus();
  });
});
