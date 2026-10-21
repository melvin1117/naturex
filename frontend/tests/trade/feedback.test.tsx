import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CountTo, PriceTick } from "@/components/live-number";
import { Receipt } from "@/components/trade-summary";
import { Toaster } from "@/components/ui/sonner";
import type { OrderOut } from "@/lib/api/types";
import { TOAST_MS, TOASTER_PROPS, WELCOME_TOAST_MS } from "@/lib/feedback";
import { useValueTick } from "@/lib/motion";

import { stubMotion } from "../motion";

let motion: ReturnType<typeof stubMotion> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  motion?.restore();
  motion = null;
});

async function advance(ms: number, tick = 50) {
  let left = ms;
  do {
    const step = Math.min(tick, left);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
    left -= step;
  } while (left > 0);
}

const int = (n: number) => Math.round(n).toLocaleString("en-US");

describe("useValueTick", () => {
  it("reports moves between known values, and keeps the last direction", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number | null }) => useValueTick(value),
      { initialProps: { value: 20 as number | null } },
    );
    expect(result.current).toEqual({ direction: null, moves: 0 });
    rerender({ value: 21.5 });
    expect(result.current).toEqual({ direction: "up", moves: 1 });
    rerender({ value: 21.5 });
    expect(result.current).toEqual({ direction: "up", moves: 1 });
    rerender({ value: 19 });
    expect(result.current).toEqual({ direction: "down", moves: 2 });
    // A value that goes away and comes back isn't a move.
    rerender({ value: null });
    rerender({ value: 30 });
    expect(result.current).toEqual({ direction: "down", moves: 2 });
  });
});

describe("PriceTick", () => {
  it("flashes once per move and keeps the direction as text, not colour alone", () => {
    const { rerender, container } = render(
      <PriceTick value={20} format={(n) => `$${n.toFixed(2)}`} />,
    );
    expect(container.querySelector(".nx-flash")).toBeNull();
    expect(screen.queryByText(/from the previous price/)).toBeNull();

    rerender(<PriceTick value={21.5} format={(n) => `$${n.toFixed(2)}`} />);
    const flash = container.querySelector(".nx-flash") as HTMLElement;
    expect(flash).toHaveTextContent("$21.50");
    expect(flash.style.getPropertyValue("--nx-flash-color")).toBe(
      "var(--lime-ink)",
    );
    expect(screen.getByText(/up from the previous price/)).toHaveClass(
      "sr-only",
    );
    // Not a live region: ticks aren't announced.
    expect(container.querySelector("[aria-live]")).toBeNull();

    rerender(<PriceTick value={19} format={(n) => `$${n.toFixed(2)}`} />);
    const next = container.querySelector(".nx-flash") as HTMLElement;
    expect(next).not.toBe(flash);
    expect(next.style.getPropertyValue("--nx-flash-color")).toBe(
      "var(--clay-ink)",
    );
    expect(
      screen.getByText(/down from the previous price/),
    ).toBeInTheDocument();
  });
});

describe("CountTo", () => {
  it("shows the exact new value at once under reduced motion", () => {
    motion = stubMotion({ reduce: true });
    const { rerender, container } = render(<CountTo value={10} format={int} />);
    expect(container).toHaveTextContent(/^10$/);
    rerender(<CountTo value={25} format={int} />);
    expect(container).toHaveTextContent(/^25$/);
  });

  it("counts from the previous value and lands exactly on the new one", async () => {
    motion = stubMotion({ reduce: false });
    const { rerender, container } = render(
      <CountTo value={9799.8} format={(n) => n.toFixed(2)} />,
    );
    expect(container).toHaveTextContent("9799.80");
    rerender(<CountTo value={9599.6} format={(n) => n.toFixed(2)} />);
    // Assistive tech hears only the final value while it counts.
    expect(container.querySelector(".sr-only")).toHaveTextContent("9599.60");
    await advance(300);
    const shown = Number(
      container.querySelector("[aria-hidden]")?.textContent ?? "NaN",
    );
    expect(shown).toBeLessThan(9799.8);
    expect(shown).toBeGreaterThan(9599.6);
    await advance(400);
    expect(container.textContent).toBe("9599.60");
  });

  it("counts a fresh stake's units from before the fill", async () => {
    motion = stubMotion({ reduce: false });
    const { container } = render(<CountTo value={15} from={5} format={int} />);
    expect(container.querySelector(".sr-only")).toHaveTextContent("15");
    await advance(700);
    expect(container.textContent).toBe("15");
  });
});

describe("the receipt", () => {
  it("points every fill to Your stakes, in place rather than in a toast", () => {
    const order = {
      id: "o",
      asset_id: "a",
      side: "buy",
      qty: 10,
      fill_price: "20.0200",
      total: "200.20",
      primary_qty: 0,
      community_amount: "0.00",
      is_primary: false,
      created_at: "2026-10-18T00:00:00Z",
      cash_balance: "9799.80",
      shares_held: 25,
    } as OrderOut;
    render(<Receipt order={order} community="Laguna Viva" />);
    expect(
      screen.getByRole("link", { name: "View your stakes" }),
    ).toHaveAttribute("href", "/portfolio");
  });
});

describe("toast placement", () => {
  it("keeps toasts at the bottom, clear of the header and account menu", async () => {
    vi.useRealTimers();
    render(<Toaster {...TOASTER_PROPS} />);
    act(() => {
      toast("Welcome back, Arjun", { duration: WELCOME_TOAST_MS });
    });
    await waitFor(() =>
      expect(
        document.querySelector("[data-sonner-toaster]"),
      ).toBeInTheDocument(),
    );
    const toaster = document.querySelector("[data-sonner-toaster]")!;
    expect(toaster).toHaveAttribute("data-y-position", "bottom");
    expect(toaster).toHaveAttribute("data-x-position", "left");
    act(() => toast.dismiss());
  });

  it("keeps routine toasts short, and the welcome shorter", () => {
    expect(TOASTER_PROPS.duration).toBeLessThanOrEqual(4000);
    expect(TOAST_MS).toBeLessThanOrEqual(4000);
    expect(WELCOME_TOAST_MS).toBeLessThan(TOAST_MS);
  });
});
