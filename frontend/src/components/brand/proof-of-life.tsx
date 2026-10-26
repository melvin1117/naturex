"use client";

import { cn } from "cn";

import { CopyIcon, useCopy } from "@/components/account-id";
import { GRADE_FILL } from "@/components/proto/grade";
import { Button } from "@/components/ui/button";
import { clampScore, SEAL, SEAL_RISE_MS, sealDots } from "@/lib/brand";
import { useInSandbox } from "@/lib/nav";
import type { Grade } from "@/lib/site-data";

import { Lockup } from "./lockup";

/**
 * The Proof of Life seal, drawn as `sealInner()` in the guidelines (chapter 5): one ring of 100
 * dots, one per point of health, lit up to the report's score, with "PROOF OF LIFE", the grade
 * and the quarter in the centre. Not the live dial's five rings: the dial is the live reading,
 * the seal the verdict issued each quarter. On paper the lit dots take the grade's colour; on
 * forest, lime; unlit dots are the ink at 20%. With `rise`, the dots light in order and the grade
 * is stamped after them (DESIGN.md, Motion); reduced motion shows the final frame. Only on the
 * quarterly report's header and its share card, always with the site's name and the quarter.
 */
export function ProofOfLifeSeal({
  health,
  grade,
  quarter,
  siteName,
  size = 160,
  ground = "paper",
  rise = false,
  className,
}: {
  health: number;
  grade: Grade;
  /** "Q3 2026". */
  quarter: string;
  siteName: string;
  size?: number;
  ground?: "paper" | "forest";
  /** Light the dots and stamp the grade once (the report was just opened). */
  rise?: boolean;
  className?: string;
}) {
  const score = clampScore(health);
  const dots = sealDots(score);
  const lit = dots.filter((d) => d.lit).length;
  const litFill = ground === "forest" ? "fill-lime" : GRADE_FILL[grade];
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={`Proof of Life seal for ${siteName}, ${quarter}: grade ${grade}, health ${score.toFixed(1)} out of 100`}
      className={cn(
        "shrink-0",
        ground === "forest" ? "text-primary-foreground" : "text-foreground",
        className,
      )}
    >
      {dots.map((d, i) => (
        <circle
          key={i}
          cx={d.cx}
          cy={d.cy}
          r={SEAL.dot}
          className={d.lit ? cn(litFill, rise && "ww-dot-on") : "fill-current"}
          opacity={d.lit ? undefined : SEAL.unlitOpacity}
          style={
            d.lit && rise
              ? { animationDelay: `${Math.round((SEAL_RISE_MS * i) / lit)}ms` }
              : undefined
          }
        />
      ))}
      <text
        x={SEAL.center}
        y={SEAL.title.y}
        textAnchor="middle"
        className="font-mono"
        fontSize={SEAL.title.size}
        letterSpacing={SEAL.title.tracking}
        fill="currentColor"
        opacity={SEAL.title.opacity}
      >
        {SEAL.title.text}
      </text>
      <text
        x={SEAL.center}
        y={SEAL.quarter.y}
        textAnchor="middle"
        className="font-mono"
        fontSize={SEAL.quarter.size}
        letterSpacing={SEAL.quarter.tracking}
        fill="currentColor"
        opacity={SEAL.quarter.opacity}
      >
        {quarter}
      </text>
      <text
        x={SEAL.center}
        y={SEAL.grade.y}
        textAnchor="middle"
        className={cn("font-serif", rise && "ww-stamp")}
        fontSize={grade.length > 2 ? SEAL.grade.longSize : SEAL.grade.size}
        fill="currentColor"
        style={
          rise
            ? {
                transformBox: "fill-box",
                transformOrigin: "center",
                animationDelay: `${SEAL_RISE_MS}ms`,
              }
            : undefined
        }
      >
        {grade}
      </text>
    </svg>
  );
}

/**
 * The share card of a Proof of Life (guidelines chapter 12): the lockup, "{site} rates {grade}",
 * the quarter, and the seal on forest. Outside the sandbox it copies a link to the report, so
 * the evidence is one click away from wherever it's shared.
 */
export function ProofOfLifeShareCard({
  version,
  siteName,
  health,
  grade,
  quarter,
  simulated = false,
  className,
}: {
  /** The report version on the card; the copied link opens that version. */
  version: number;
  siteName: string;
  health: number;
  grade: Grade;
  quarter: string;
  simulated?: boolean;
  className?: string;
}) {
  const inSandbox = useInSandbox();
  const link =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}${window.location.pathname}?tab=report&version=${version}`;
  const { state, copy } = useCopy(link);
  return (
    <div
      role="group"
      aria-label="Share card"
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-4 gap-y-4 overflow-hidden rounded-3xl bg-primary p-6 text-primary-foreground shadow-soft",
        className,
      )}
    >
      <div className="min-w-0">
        <Lockup size={22} reading="lime" />
        <p className="mt-4 font-serif text-2xl leading-[1.05] tracking-[-0.01em] text-balance sm:text-3xl">
          {siteName} rates {grade}
        </p>
        <p className="mt-2 font-mono text-[11px] tracking-[0.06em] uppercase opacity-80">
          Proof of Life · {quarter}
          {simulated && " · Simulated"} · Sandbox
        </p>
      </div>
      <ProofOfLifeSeal
        health={health}
        grade={grade}
        quarter={quarter}
        siteName={siteName}
        size={112}
        ground="forest"
      />
      {!inSandbox && (
        <div className="col-span-2">
          <Button
            type="button"
            variant="on-image"
            size="sm"
            data-state={state}
            onClick={() => void copy()}
          >
            <CopyIcon copied={state === "copied"} />
            {state === "copied" ? "Link copied" : "Copy link to this report"}
          </Button>
          <p aria-live="polite" className="text-xs">
            {state === "copied" && (
              <span className="sr-only">Link to this report copied.</span>
            )}
            {state === "failed" &&
              "Couldn't copy. Copy the address from your browser."}
          </p>
        </div>
      )}
    </div>
  );
}
