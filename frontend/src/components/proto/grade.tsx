import { cn } from "cn";

import type { Grade } from "@/lib/prototype/data";
import { GRADE_LABEL } from "@/lib/prototype/format";

export const GRADE_BG: Record<Grade, string> = {
  AAA: "bg-grade-aaa",
  AA: "bg-grade-aa",
  A: "bg-grade-a",
  BBB: "bg-grade-bbb",
  BB: "bg-grade-bb",
  B: "bg-grade-b",
  C: "bg-grade-c",
  D: "bg-grade-d",
};

/** Grade colour as an SVG fill, e.g. the Proof of Life seal's lit dots on paper. */
export const GRADE_FILL: Record<Grade, string> = {
  AAA: "fill-grade-aaa",
  AA: "fill-grade-aa",
  A: "fill-grade-a",
  BBB: "fill-grade-bbb",
  BB: "fill-grade-bb",
  B: "fill-grade-b",
  C: "fill-grade-c",
  D: "fill-grade-d",
};

export const GRADE_TEXT: Record<Grade, string> = {
  AAA: "text-grade-aaa",
  AA: "text-grade-aa",
  A: "text-grade-a",
  BBB: "text-grade-bbb",
  BB: "text-grade-bb",
  B: "text-grade-b",
  C: "text-grade-c",
  D: "text-grade-d",
};

/** Light grades get dark ink; every badge clears 4.5:1 (checked in oklch → sRGB). */
const DARK_INK: Grade[] = ["BBB", "BB", "B"];

export function GradeBadge({
  grade,
  health,
  showLabel = false,
  size = "md",
  className,
}: {
  grade: Grade;
  health?: number;
  showLabel?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <span
      role="img"
      className={cn("inline-flex items-center gap-2", className)}
      aria-label={`Grade ${grade}${health !== undefined ? `, health ${health.toFixed(1)}` : ""}, ${GRADE_LABEL[grade]}`}
    >
      <span
        className={cn(
          "tabular inline-flex items-center justify-center rounded-full font-semibold tracking-tight",
          GRADE_BG[grade],
          DARK_INK.includes(grade) ? "text-foreground" : "text-white",
          size === "sm" && "h-6 min-w-9 px-2 text-xs",
          size === "md" && "h-7 min-w-11 px-2.5 text-sm",
          size === "lg" && "h-9 min-w-14 px-3.5 text-base",
        )}
        aria-hidden="true"
      >
        {grade}
      </span>
      {(showLabel || health !== undefined) && (
        <span className="text-sm text-muted-foreground" aria-hidden="true">
          {health !== undefined && (
            <span className="tabular font-medium text-foreground">
              {health.toFixed(1)}
            </span>
          )}
          {health !== undefined && showLabel && " · "}
          {showLabel && GRADE_LABEL[grade]}
        </span>
      )}
    </span>
  );
}

/**
 * The rating stamp: the grade pressed onto the report card when a rating lands. `animate`
 * presses it in (after `delay` ms, to follow an earlier beat of a reveal).
 */
export function GradeStamp({
  grade,
  animate = false,
  delay = 0,
  className,
}: {
  grade: Grade;
  animate?: boolean;
  delay?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative grid size-24 shrink-0 -rotate-3 place-items-center rounded-full border-[3px] border-dashed",
        GRADE_TEXT[grade],
        "border-current",
        animate && "ww-stamp",
        className,
      )}
      style={animate && delay ? { animationDelay: `${delay}ms` } : undefined}
      role="img"
      aria-label={`Grade ${grade}: ${GRADE_LABEL[grade]}`}
    >
      <div className="grid size-[80%] place-items-center rounded-full border border-current/60 bg-card/70">
        <span className="font-serif text-4xl leading-none">{grade}</span>
      </div>
    </div>
  );
}
