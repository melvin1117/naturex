/**
 * Where feedback lives (#216 WP2; docs/design/ux-writing.md §9). Pick the lowest rung that's
 * enough:
 *
 * 1. Inline: field validity and refusals, next to the control, with the fix.
 * 2. In place: the surface the user acted on changes (a receipt, a row that washes, a number
 *    counting to its new value), and links to where the consequence also lives.
 * 3. Toast: only when the consequence is on another page or comes from the background
 *    (signed in, signed out, a new alert). Never for an error the user has to fix.
 *
 * Toasts sit at the bottom: bottom-left on wide screens, full width at the bottom on phones,
 * so they never cover the header, the account menu or the trade panel (right column).
 */
import type { ToasterProps } from "sonner";

/** The longest a routine toast stays (alerts, which carry news, may stay longer). */
export const TOAST_MS = 4000;

export const TOASTER_PROPS = {
  position: "bottom-left",
  offset: 24,
  mobileOffset: { bottom: "calc(16px + env(safe-area-inset-bottom))" },
  duration: TOAST_MS,
  visibleToasts: 3,
} as const satisfies ToasterProps;
