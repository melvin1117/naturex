import { useEffect, useState } from "react";

/**
 * `value` once it has stopped changing for `delayMs`. Compared by identity, so memoize
 * objects and tuples (e.g. `useMemo(() => [a, b] as const, [a, b])`).
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
