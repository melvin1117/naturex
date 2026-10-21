"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { focusIfLost } from "@/lib/focus";

/** Long enough for a page's data to load; after that, a late heading doesn't grab focus. */
const WAIT_MS = 15_000;

/**
 * Focuses the first `<h1>` of `children` once, as soon as it appears (pages often show a loader
 * first). For content that replaces what held focus, such as the page shown after a community
 * is created in place of its form. Only if focus was lost to `<body>` meanwhile.
 */
export function FocusFirstHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const tryFocus = () => {
      const heading = root.querySelector("h1");
      if (!heading) return false;
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      focusIfLost(heading);
      return true;
    };
    if (tryFocus()) return;
    const observer = new MutationObserver(() => {
      if (tryFocus()) stop();
    });
    const timer = setTimeout(() => stop(), WAIT_MS);
    function stop() {
      observer.disconnect();
      clearTimeout(timer);
    }
    observer.observe(root, { childList: true, subtree: true });
    return stop;
  }, []);
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}
