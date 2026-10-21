import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * For a dialog or sheet opened from app state rather than a Radix trigger: remembers what had
 * focus when it opened and returns the `onCloseAutoFocus` handler that puts focus back there,
 * as a trigger would. The layout effect runs before Radix moves focus into the content.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    opener.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);
  return useCallback((event: Event) => {
    const target = opener.current;
    opener.current = null;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  }, []);
}
