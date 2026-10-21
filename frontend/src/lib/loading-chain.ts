/**
 * Consecutive loading regions are one wait to the visitor: a route's `loading.tsx`, then the
 * session gate, then the page's own loader. They share one chain here, so the slow-load note
 * counts from the first region (not from each phase) and a label already announced in the
 * chain isn't announced again. A chain ends once no region has been on screen for
 * `HANDOFF_MS`.
 */

export const HANDOFF_MS = 1000;

export type LoadingChain = {
  /** When the first region of this chain appeared (ms since epoch). */
  since: number;
  /** Labels already announced in this chain. */
  announced: Set<string>;
  /** Whether the slow-load note has been announced in this chain. */
  slowAnnounced: boolean;
};

let chain: LoadingChain | null = null;
let active = 0;
let lastEnd = -Infinity;

/** A region appeared: joins the current chain, or starts one after a quiet gap. */
export function beginLoading(now: number): LoadingChain {
  if (!chain || (active === 0 && now - lastEnd > HANDOFF_MS)) {
    chain = { since: now, announced: new Set(), slowAnnounced: false };
  }
  active += 1;
  return chain;
}

/** A region went away (its content arrived, or the next phase replaced it). */
export function endLoading(now: number): void {
  active = Math.max(0, active - 1);
  if (active === 0) lastEnd = now;
}

/** For tests: forget every chain. */
export function resetLoadingChains(): void {
  chain = null;
  active = 0;
  lastEnd = -Infinity;
}
