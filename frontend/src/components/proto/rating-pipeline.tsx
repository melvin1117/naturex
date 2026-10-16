"use client";

import { Check, CircleDashed, Cpu, Loader2, Lock, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { LiveBadge } from "@/components/proto/bits";
import type { RatingRun, TraceStep } from "@/lib/prototype/trace";

const ICON: Record<TraceStep["kind"], typeof Cpu> = {
  llm: Cpu,
  tool: Wrench,
  seal: Lock,
};

/**
 * The rating run as a lit pipeline on the machine layer. With `play`, steps light up in order
 * (compressed timing), then `onDone` fires.
 */
export function RatingPipeline({
  run,
  play,
  onDone,
  className,
}: {
  run: RatingRun;
  play: boolean;
  onDone?: () => void;
  className?: string;
}) {
  const [active, setActive] = useState(play ? 0 : run.steps.length);

  useEffect(() => {
    if (!play) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let i = 0;
    let timer: number;
    const advance = () => {
      i += 1;
      setActive(i);
      if (i >= run.steps.length) {
        onDone?.();
        return;
      }
      const step = run.steps[i];
      timer = window.setTimeout(
        advance,
        reduced ? 120 : Math.min(1500, 450 + step.latencyMs / 6),
      );
    };
    timer = window.setTimeout(advance, reduced ? 120 : 700);
    return () => window.clearTimeout(timer);
    // Replays only when a new run starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, play]);

  return (
    <ol className={cn("relative space-y-1", className)} aria-live="polite">
      {run.steps.map((step, i) => {
        const done = i < active;
        const running = i === active && play;
        const Icon = ICON[step.kind];
        return (
          <li
            key={step.id}
            className={cn(
              "relative flex items-start gap-3 rounded-2xl px-3 py-2.5 transition-colors duration-300",
              running && "bg-machine-raised",
            )}
          >
            <span
              className={cn(
                "mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl transition-colors duration-300",
                done
                  ? "bg-lime text-machine"
                  : running
                    ? "bg-machine-line text-lime"
                    : "bg-machine-raised text-machine-muted",
              )}
              aria-hidden="true"
            >
              {done ? (
                <Check className="size-4" />
              ) : running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CircleDashed className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={cn(
                    "text-sm font-medium",
                    done || running ? "text-machine-ink" : "text-machine-muted",
                  )}
                >
                  {step.label}
                </span>
                {step.kind === "llm" && (done || running) && (
                  <LiveBadge className="bg-lime/15 text-lime" />
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-machine-muted">
                <Icon className="size-3" aria-hidden="true" />
                <span>{step.agent}</span>
                {step.model && <span>· {step.model.name}</span>}
                {done && (
                  <span className="tabular">
                    · {(step.latencyMs / 1000).toFixed(1)} s
                  </span>
                )}
              </div>
              {running && <div className="nx-flow mt-2 h-0.5 rounded-full" />}
            </div>
            <span className="sr-only">
              {done ? "done" : running ? "running" : "waiting"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
