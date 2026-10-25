/**
 * WildWorth's motion vocabulary (DESIGN.md; interaction principles in #216). Motion is purely
 * presentational: it may delay or replay what the API returned, never invent a value or a step.
 *
 * - `DURATION` mirrors the CSS tokens in `app/globals.css` (`--ww-duration-*`; the ease-out curve
 *   is `--ww-ease-out`).
 * - `usePrefersReducedMotion()`: true when the visitor asked for less motion (and on the
 *   server, so the first paint is always the final state).
 * - `useCountUp(value)`: a newly computed number counting up once, landing exactly on `value`.
 * - `usePacedCount(target, stepMs)`: a count that catches up with `target` one step at a time,
 *   so a burst of real events reads as a sequence.
 * - `useValueTick(value)`: which way a live value (a price) last moved, and a count of its moves,
 *   so a numeral can flash once per move and keep a direction arrow.
 * - `stagger(index)`: the inline style that delays a CSS keyframe (`ww-rise`, `ww-fade`…) for
 *   item `index` of a list that appears as a list, e.g. new portfolio rows.
 *
 * Under reduced motion every helper returns its final state at once: same information, no motion.
 */
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

/** Milliseconds. UI state 120–200, content arriving 360, milestone reveals 600–1,200. */
export const DURATION = {
  /** Tabs, popovers, hover: a routine change of state. */
  ui: 160,
  /** A live value that moved (`ww-flash`), or a number counting to its new value after a fill. */
  tick: 600,
  /** Content arriving (`ww-rise`). */
  content: 360,
  /** The grade stamp pressing onto the card (`ww-stamp`). */
  stamp: 520,
  /** A milestone's instrument filling up (the health dial, the opening-offer ring). */
  reveal: 900,
} as const;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** The ease-out curve (`--ww-ease-out`) for values driven frame by frame: a quartic ease-out. */
export function easeOut(t: number): number {
  return 1 - (1 - clamp01(t)) ** 4;
}

/** When the ease-out reaches `progress`: delays that keep a staggered row in step with a count-up. */
export function easeOutInverse(progress: number): number {
  return 1 - (1 - clamp01(progress)) ** (1 / 4);
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => {};
  const query = window.matchMedia(REDUCED_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** No `matchMedia` (old browsers, tests): assume reduced, so the final state always shows. */
function reducedNow(): boolean {
  return (
    typeof window.matchMedia !== "function" ||
    window.matchMedia(REDUCED_QUERY).matches
  );
}

/** True when the visitor prefers reduced motion; follows the setting live. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reducedNow, () => true);
}

/**
 * A newly computed number counting up from `from` to `value`, once, on mount. Ends on exactly
 * `value` (never a rounding of it); later changes of `value` show at once, and so does turning
 * on reduced motion mid-count. Render it with `tabular-nums` so the width doesn't jitter, and
 * give assistive tech the final value.
 */
export function useCountUp(
  value: number,
  {
    from = 0,
    duration = DURATION.reveal,
    delay = 0,
    enabled = true,
  }: {
    /** Where the count starts. */
    from?: number;
    duration?: number;
    /** Wait this long before counting (to follow an earlier beat of a reveal). */
    delay?: number;
    /** False shows `value` at once (an old value, not a newly computed one). */
    enabled?: boolean;
  } = {},
): number {
  const reduced = usePrefersReducedMotion();
  const animate = enabled && !reduced && duration > 0 && from !== value;
  // Progress through the count, or null once it has landed (or never ran).
  const [progress, setProgress] = useState<number | null>(animate ? 0 : null);
  if (!animate && progress !== null) setProgress(null);
  const counting = animate && progress !== null;
  useEffect(() => {
    if (!counting) return;
    let frame = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const t = (now - start - delay) / duration;
      if (t >= 1) {
        setProgress(null);
        return;
      }
      setProgress(Math.max(0, t));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [counting, delay, duration]);
  if (!counting) return value;
  return from + (value - from) * easeOut(progress);
}

/**
 * A count that follows `target` but moves at most one step every `stepMs`, so a burst of real
 * events (several steps finishing at once) lights one by one. It only ever lags `target`; it
 * never runs ahead of it. A new `resetKey` (a new run) starts it again from 0. With `paced`
 * false, or under reduced motion, it equals `target`.
 */
export function usePacedCount(
  target: number,
  stepMs: number,
  { paced = true, resetKey }: { paced?: boolean; resetKey?: unknown } = {},
): number {
  const reduced = usePrefersReducedMotion();
  const live = paced && !reduced;
  const [state, setState] = useState({
    key: resetKey,
    shown: live ? 0 : target,
  });
  const lastStep = useRef(0);
  let { shown } = state;
  // A new run starts over; not pacing, or a target that fell back, is followed at once.
  if (state.key !== resetKey) shown = live ? 0 : target;
  else if ((!live && shown !== target) || shown > target) shown = target;
  if (state.key !== resetKey || shown !== state.shown)
    setState({ key: resetKey, shown });
  useEffect(() => {
    if (!live || shown >= target) return;
    const wait = Math.max(0, lastStep.current + stepMs - Date.now());
    const timer = setTimeout(() => {
      lastStep.current = Date.now();
      setState((s) => ({ ...s, shown: s.shown + 1 }));
    }, wait);
    return () => clearTimeout(timer);
  }, [live, shown, target, stepMs]);
  return live ? Math.min(shown, target) : target;
}

/**
 * The inline style that delays item `index`'s CSS animation by `index × step` ms after `base`.
 * Kept for WP2's new rows and receipts; cap the total delay so a long list doesn't wait.
 */
export function stagger(index: number, step = 60, base = 0): CSSProperties {
  return { animationDelay: `${Math.round(base + index * step)}ms` };
}

export type ValueTick = {
  /** Which way the value last moved while on screen; null until it has moved. */
  direction: "up" | "down" | null;
  /** How many moves have been seen: a new key per move restarts the flash. */
  moves: number;
};

/**
 * Follows a live value (a stake price) and reports its last move. The first value, and a value
 * that comes or goes (null), is not a move: only a change between two known values is. While
 * `armed` is false (e.g. the first refresh of a cached value after the page opened), changes
 * are taken as they are, not as moves; a change counts only if the hook was already armed.
 * Motion-free (it only reports); the flash it drives is CSS, off under reduced motion, and the
 * direction stays so the change never relies on colour or motion alone.
 */
export function useValueTick(
  value: number | null,
  { armed = true }: { armed?: boolean } = {},
): ValueTick {
  const [state, setState] = useState<
    ValueTick & { last: number | null; armed: boolean }
  >({ last: value, direction: null, moves: 0, armed });
  let next = state;
  if (value !== state.last || armed !== state.armed) {
    const moved =
      state.armed &&
      value !== state.last &&
      value !== null &&
      state.last !== null;
    next = {
      last: value,
      armed,
      direction: moved
        ? value > state.last!
          ? "up"
          : "down"
        : state.direction,
      moves: moved ? state.moves + 1 : state.moves,
    };
    setState(next);
  }
  return { direction: next.direction, moves: next.moves };
}
