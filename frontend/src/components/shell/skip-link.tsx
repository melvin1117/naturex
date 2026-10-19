/** The `id` of every page's `<main>`, the skip link's target. */
export const MAIN_ID = "main";

/** First stop for keyboard users: jumps past the demo bar and the header. */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_ID}`}
      className="fixed top-3 left-3 z-[60] -translate-y-[200%] rounded-full bg-background px-4 py-2 text-sm font-medium text-foreground shadow-soft outline-none focus:translate-y-0 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      Skip to content
    </a>
  );
}
