/** The `id` of every page's `<main>`, the skip link's target. */
export const MAIN_ID = "main";

/** First stop for keyboard users: jumps past the demo bar and the header. */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_ID}`}
      className="sr-only rounded-full bg-background px-4 py-2 text-sm font-medium text-foreground shadow-soft focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      Skip to content
    </a>
  );
}
