import {
  ArrowLeft,
  ArrowRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Clock,
  Info,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { cn } from "cn";

import { LoadingRegion } from "@/components/loading-region";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChecklistState, ChecklistStep } from "@/lib/community";
import type { Explanation } from "@/lib/ipo";

/**
 * Building blocks shared by the steward's focused screens (T64): the opening offer's form and
 * outcomes, and the verification and field evidence screens that reuse its shell.
 */

export function IpoShell({
  homeHref,
  children,
}: {
  homeHref: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-8 pb-16 sm:px-6">
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-3">
        <Link href={homeHref}>
          <ArrowLeft aria-hidden="true" />
          Community home
        </Link>
      </Button>
      {children}
    </div>
  );
}

export function IpoCard({
  className,
  ...rest
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "rounded-[1.75rem] bg-card p-6 shadow-soft sm:p-8",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * Rows still loading inside a card (the price steps, a list of documents): label and value
 * blocks at the rows' height, one polite status naming what's loading (#219). Page-level
 * waits use `ScreenSkeleton`, the shape the route's `loading.tsx` drew.
 */
export function IpoLoading({
  children,
  rows = 5,
}: {
  children: string;
  rows?: number;
}) {
  return (
    <LoadingRegion name="card-rows" label={children}>
      <div className="space-y-3 py-1">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex h-6 items-center justify-between gap-4">
            <Skeleton className={cn("h-4", i % 2 ? "w-2/5" : "w-1/2")} />
            <Skeleton className="h-4 w-20 shrink-0" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

const STEP_ICON: Record<ChecklistState, typeof Circle> = {
  done: CircleCheck,
  current: CircleDot,
  waiting: Clock,
  upcoming: Circle,
  optional: CircleDashed,
};

const STEP_TONE: Record<ChecklistState, string> = {
  done: "text-lime-ink",
  current: "text-foreground",
  waiting: "text-clay-ink",
  upcoming: "text-muted-foreground",
  optional: "text-muted-foreground",
};

/**
 * "Before you open to supporters" (#216): the steps in order, at the top of the opening offer,
 * so whatever blocks it is the first thing read and one click away. Each step says its state in
 * words beside its icon, never by colour alone.
 */
export function OpeningChecklist({
  steps,
  className,
}: {
  steps: ChecklistStep[];
  className?: string;
}) {
  return (
    <section
      aria-labelledby="checklist-heading"
      className={cn(
        "rounded-[1.75rem] bg-card p-5 shadow-soft sm:p-6",
        className,
      )}
    >
      <h2 id="checklist-heading" className="text-lg font-semibold">
        Before you open to supporters
      </h2>
      <ol className="mt-4 grid gap-4 md:grid-cols-3 md:gap-6">
        {steps.map((step, index) => {
          const Icon = STEP_ICON[step.state];
          const current = step.state === "current";
          return (
            <li
              key={step.id}
              data-step={step.id}
              data-state={step.state}
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex min-w-0 gap-3 rounded-2xl p-3 md:flex-col md:gap-2",
                current && "bg-secondary/60",
              )}
            >
              <Icon
                className={cn("mt-0.5 size-5 shrink-0", STEP_TONE[step.state])}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  <span className="sr-only">Step {index + 1}: </span>
                  {step.label}
                  <span className="text-muted-foreground">
                    {" · "}
                    {step.status}
                  </span>
                </p>
                <p className="mt-1 text-sm text-pretty break-words text-muted-foreground">
                  {step.detail}
                </p>
                {step.action && (
                  <Button
                    asChild
                    size="sm"
                    variant={current ? "default" : "outline"}
                    className="mt-3"
                  >
                    <Link href={step.action.href}>
                      {step.action.label}
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * Why the launch can't go ahead, in words; `onRetry` adds "Check again", `action` a way to
 * fix it (e.g. the verification screen).
 */
export function BlockedAlert({
  explanation,
  className,
  onRetry,
  action,
  ref,
}: {
  explanation: Explanation;
  className?: string;
  onRetry?: () => void;
  action?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <Alert ref={ref} tabIndex={-1} className={cn("outline-none", className)}>
      <Info aria-hidden="true" />
      <AlertTitle>{explanation.title}</AlertTitle>
      <AlertDescription>
        <p>{explanation.body}</p>
        {(onRetry || action) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {action}
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCwIcon aria-hidden="true" />
                Check again
              </Button>
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function ErrorAlert({
  title,
  message,
  onRetry,
  className,
  ref,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <Alert
      ref={ref}
      tabIndex={-1}
      variant="destructive"
      className={cn("outline-none", className)}
    >
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={onRetry}
          >
            <RefreshCwIcon aria-hidden="true" />
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
