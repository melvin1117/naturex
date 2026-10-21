/**
 * jsdom has no `matchMedia`, which `lib/motion.ts` reads as reduced motion. This stub answers
 * `(prefers-reduced-motion: reduce)` with `reduce`, and `(max-width: …)` queries with `stacked`
 * (a phone-width layout); `set` flips the reduced-motion setting and notifies listeners.
 */
export function stubMotion({
  reduce = false,
  stacked = false,
}: { reduce?: boolean; stacked?: boolean } = {}) {
  const listeners = new Set<() => void>();
  let reduced = reduce;
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() {
      if (query.includes("prefers-reduced-motion")) return reduced;
      if (query.includes("max-width")) return stacked;
      return false;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      reduced = next;
      for (const listener of listeners) listener();
    },
    restore() {
      window.matchMedia = original;
    },
  };
}
