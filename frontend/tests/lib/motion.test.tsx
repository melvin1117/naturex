import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DotRing, HealthRing } from "@/components/proto/health-ring";
import {
  DURATION,
  easeOutInverse,
  stagger,
  useCountUp,
  usePacedCount,
  usePrefersReducedMotion,
} from "@/lib/motion";

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

/** Run the fake clock (timers and animation frames) forward, letting React render each tick. */
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

describe("usePrefersReducedMotion", () => {
  it("assumes reduced motion when the browser can't say", () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("follows the setting live", () => {
    motion = stubMotion({ reduce: false });
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => motion!.set(true));
    expect(result.current).toBe(true);
  });
});

describe("useCountUp", () => {
  it("shows the exact value at once under reduced motion", () => {
    motion = stubMotion({ reduce: true });
    const { result } = renderHook(() => useCountUp(77.6));
    expect(result.current).toBe(77.6);
  });

  it("counts up from `from` and lands exactly on the value", async () => {
    motion = stubMotion();
    const seen: number[] = [];
    const { result } = renderHook(() => {
      const value = useCountUp(77.6, { from: 0, duration: 900 });
      seen.push(value);
      return value;
    });
    expect(result.current).toBe(0);
    await advance(450);
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(77.6);
    await advance(600);
    expect(result.current).toBe(77.6);
    // It only ever climbs, and never past the value.
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(Math.max(...seen)).toBe(77.6);
  });

  it("waits out its delay before counting", async () => {
    motion = stubMotion();
    const { result } = renderHook(() =>
      useCountUp(50, { delay: 300, duration: 300 }),
    );
    await advance(250);
    expect(result.current).toBe(0);
    await advance(400);
    expect(result.current).toBe(50);
  });

  it("shows an old value as it is (enabled: false)", () => {
    motion = stubMotion();
    const { result } = renderHook(() => useCountUp(42.1, { enabled: false }));
    expect(result.current).toBe(42.1);
  });

  it("cancels its frame when it unmounts mid-count", async () => {
    motion = stubMotion();
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
    const { unmount } = renderHook(() => useCountUp(90, { duration: 900 }));
    await advance(100);
    unmount();
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    cancel.mockRestore();
  });

  it("jumps to the end when reduced motion is turned on mid-count", async () => {
    motion = stubMotion();
    const { result } = renderHook(() => useCountUp(90, { duration: 900 }));
    await advance(100);
    expect(result.current).toBeLessThan(90);
    act(() => motion!.set(true));
    expect(result.current).toBe(90);
  });
});

describe("usePacedCount", () => {
  it("catches up with a burst one step at a time, never ahead of the target", async () => {
    motion = stubMotion();
    const { result, rerender } = renderHook(
      ({ target }) => usePacedCount(target, 400),
      { initialProps: { target: 0 } },
    );
    expect(result.current).toBe(0);
    rerender({ target: 4 });
    await advance(0);
    expect(result.current).toBe(1);
    await advance(399);
    expect(result.current).toBe(1);
    await advance(1);
    expect(result.current).toBe(2);
    await advance(800);
    expect(result.current).toBe(4);
    await advance(2000);
    expect(result.current).toBe(4);
  });

  it("follows a target that falls back (a new run) at once", async () => {
    motion = stubMotion();
    const { result, rerender } = renderHook(
      ({ target }) => usePacedCount(target, 400),
      { initialProps: { target: 3 } },
    );
    await advance(2000);
    expect(result.current).toBe(3);
    rerender({ target: 1 });
    expect(result.current).toBe(1);
  });

  it("starts again from 0 for a new reset key (a new run)", async () => {
    motion = stubMotion();
    const { result, rerender } = renderHook(
      ({ target, run }) => usePacedCount(target, 400, { resetKey: run }),
      { initialProps: { target: 3, run: "a" } },
    );
    await advance(1200);
    expect(result.current).toBe(3);
    rerender({ target: 7, run: "b" });
    expect(result.current).toBe(0);
    await advance(0);
    expect(result.current).toBe(1);
  });

  it("clears its timer when it unmounts mid-replay", async () => {
    motion = stubMotion();
    const { result, unmount } = renderHook(() => usePacedCount(5, 400));
    await advance(0);
    expect(result.current).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isn't paced under reduced motion, or when asked not to be", () => {
    motion = stubMotion({ reduce: true });
    const reduced = renderHook(() => usePacedCount(5, 400));
    expect(reduced.result.current).toBe(5);
    motion.set(false);
    const unpaced = renderHook(() => usePacedCount(5, 400, { paced: false }));
    expect(unpaced.result.current).toBe(5);
  });
});

describe("helpers", () => {
  it("easeOutInverse says when the quartic ease-out reaches a point", () => {
    expect(easeOutInverse(0)).toBe(0);
    expect(easeOutInverse(1)).toBe(1);
    // 1 − (1 − 0.5)⁴ = 15/16.
    expect(easeOutInverse(15 / 16)).toBeCloseTo(0.5, 10);
  });

  it("stagger delays item i by i steps after the base", () => {
    expect(stagger(0)).toEqual({ animationDelay: "0ms" });
    expect(stagger(3, 80, 100)).toEqual({ animationDelay: "340ms" });
  });
});

describe("the dotted rings", () => {
  const litColumns = (container: HTMLElement) =>
    container.querySelectorAll("g.ww-dot-on").length;

  it("a new health score lights its dots and counts up to the exact score", async () => {
    motion = stubMotion();
    const { container } = render(<HealthRing value={85.1} animateFrom={0} />);
    const ring = screen.getByRole("img", { name: "Health 85.1 out of 100" });
    expect(ring).toHaveTextContent("0.0");
    expect(litColumns(container)).toBeGreaterThan(0);
    await advance(DURATION.reveal + 50);
    expect(ring).toHaveTextContent("85.1");
  });

  it("under reduced motion the score and its dots are final at once", () => {
    motion = stubMotion({ reduce: true });
    const { container } = render(<HealthRing value={85.1} animateFrom={0} />);
    expect(
      screen.getByRole("img", { name: "Health 85.1 out of 100" }),
    ).toHaveTextContent("85.1");
    expect(litColumns(container)).toBe(0);
  });

  it("a ring without a reveal is static", () => {
    motion = stubMotion();
    const { container } = render(<HealthRing value={60} />);
    expect(screen.getByRole("img")).toHaveTextContent("60.0");
    expect(litColumns(container)).toBe(0);
  });

  it("lights its segments in order, each in its own fill", () => {
    motion = stubMotion();
    const { container } = render(
      <DotRing
        size={120}
        label="Split"
        reveal={{}}
        segments={[
          { columns: 51, className: "fill-primary" },
          { columns: 49, className: "fill-lime" },
        ]}
      />,
    );
    const delays = (fill: string) =>
      [...container.querySelectorAll(`g.${fill}`)].map((c) =>
        parseInt((c as SVGElement).style.animationDelay, 10),
      );
    const kept = delays("fill-primary");
    const offered = delays("fill-lime");
    expect(Math.max(...kept)).toBeLessThanOrEqual(Math.min(...offered));
    expect(Math.max(...offered)).toBe(DURATION.reveal);
  });
});
