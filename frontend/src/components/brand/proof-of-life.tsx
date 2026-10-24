"use client";

import { cn } from "cn";

import { CopyIcon, useCopy } from "@/components/account-id";
import { GRADE_FILL } from "@/components/proto/grade";
import { DotRing } from "@/components/proto/health-ring";
import { Button } from "@/components/ui/button";
import { clampScore } from "@/lib/brand";
import { useInSandbox } from "@/lib/nav";
import type { Grade } from "@/lib/prototype/data";

import { Lockup } from "./lockup";

/** The seal's dots rise once, then the grade is stamped (DESIGN.md, Motion). */
export const SEAL_RISE_MS = 550;

/**
 * The Proof of Life seal: the health instrument issued as a verdict (guidelines chapter 5). The
 * same `DotRing` as the live dial (5 rings, 100 columns, one per point of health), lit to the
 * report's score, with "Proof of Life", the grade and the quarter in the centre instead of the
 * counting numeral. On paper the lit dots take the grade's colour; on forest, lime. Only on the
 * quarterly report's header and its share card, always with the site's name and the quarter.
 */
export function ProofOfLifeSeal({
  health,
  grade,
  quarter,
  siteName,
  size = 168,
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
  const forest = ground === "forest";
  return (
    <DotRing
      segments={[
        {
          columns: Math.round(score),
          className: forest ? "fill-lime" : GRADE_FILL[grade],
        },
      ]}
      size={size}
      unlitClassName={forest ? "fill-primary-foreground/20" : undefined}
      reveal={rise ? { from: 0, duration: SEAL_RISE_MS } : undefined}
      label={`Proof of Life seal for ${siteName}, ${quarter}: grade ${grade}, health ${score.toFixed(1)} out of 100`}
      className={className}
    >
      <div
        className={cn(
          "grid justify-items-center leading-none",
          forest ? "text-primary-foreground" : "text-foreground",
        )}
        style={{ gap: size * 0.04 }}
      >
        <span
          className="font-mono tracking-[0.08em] uppercase opacity-75"
          style={{ fontSize: Math.max(8, size * 0.05) }}
        >
          Proof of Life
        </span>
        <span
          className={cn("font-serif", rise && "nx-stamp")}
          style={{
            fontSize: size * (grade.length > 2 ? 0.17 : 0.2),
            animationDelay: rise ? `${SEAL_RISE_MS}ms` : undefined,
          }}
        >
          {grade}
        </span>
        <span
          className="font-mono tracking-[0.04em] opacity-85"
          style={{ fontSize: Math.max(9, size * 0.058) }}
        >
          {quarter}
        </span>
      </div>
    </DotRing>
  );
}

/**
 * The share card of a Proof of Life (guidelines chapter 12): the lockup, "{site} rates {grade}",
 * the quarter, and the seal on forest. Outside the sandbox it copies a link to the report, so
 * the evidence is one click away from wherever it's shared.
 */
export function ProofOfLifeShareCard({
  siteName,
  health,
  grade,
  quarter,
  simulated = false,
  className,
}: {
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
      : `${window.location.origin}${window.location.pathname}?tab=report`;
  const { state, copy } = useCopy(link);
  return (
    <div
      role="group"
      aria-label="Share card"
      className={cn(
        "relative grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 overflow-hidden rounded-3xl bg-primary p-6 text-primary-foreground shadow-soft",
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
        {!inSandbox && (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-4"
              data-state={state}
              onClick={() => void copy()}
            >
              <CopyIcon copied={state === "copied"} />
              {state === "copied" ? "Link copied" : "Copy link to this report"}
            </Button>
            <p aria-live="polite" className="mt-1.5 min-h-4 text-xs">
              {state === "copied" && (
                <span className="sr-only">Link to this report copied.</span>
              )}
              {state === "failed" &&
                "Couldn't copy. Copy the address from your browser."}
            </p>
          </>
        )}
      </div>
      <ProofOfLifeSeal
        health={health}
        grade={grade}
        quarter={quarter}
        siteName={siteName}
        size={128}
        ground="forest"
      />
    </div>
  );
}
