import { useEffect, useRef, type RefObject } from "react";

/**
 * Focus for screens that swap their content (a wizard step, a page that replaces a form).
 * Only takes focus when it was lost to `<body>` with the content that held it, so it never
 * pulls focus away from where the person is (an error field, the header, another tab).
 */
export function focusIfLost(target: HTMLElement | null): void {
  if (!target) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  target.focus();
}

/**
 * A button that disables while its request runs loses focus to `<body>`; give it back to
 * `ref` once `pending` falls (if focus is still lost).
 */
export function useRestoreFocusAfterPending(
  pending: boolean,
  ref: RefObject<HTMLElement | null>,
): void {
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending) focusIfLost(ref.current);
    wasPending.current = pending;
  }, [pending, ref]);
}
