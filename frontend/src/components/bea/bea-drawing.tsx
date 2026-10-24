import { createElement, useId, type ReactNode } from "react";

import { BEA, type BeaDrawingState, type BeaNode } from "./drawings";

function render(nodes: readonly BeaNode[], clip: string): ReactNode[] {
  return nodes.map(([tag, attrs, children], i) => {
    const props: Record<string, string | number> = { key: i };
    for (const [name, value] of Object.entries(attrs))
      props[name] = value.replace("CLIP", clip);
    return createElement(tag, props, ...render(children, clip));
  });
}

/**
 * Bea's drawing in one of her six states, exactly as `bea()` draws her in the character sheet:
 * ink only (`currentColor`), with the wings and body filled by the ground (`--bea-ground`) so
 * the outlines overlap cleanly. Draw it inside an `<svg viewBox="0 0 120 124">`, or
 * `"10 12 100 100"` for the icon. The groups keep the sheet's class names (`bea-ant`,
 * `bea-wl`, `bea-wr`, `eyes`, `bea-dots`, `bea-z`) for her motion.
 */
export function BeaDrawing({ state = "neutral" }: { state?: BeaDrawingState }) {
  const clip = `bea-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return <g className={`s-${state}`}>{render(BEA[state], clip)}</g>;
}
