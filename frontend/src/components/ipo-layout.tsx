import {
  ArrowLeft,
  Info,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { cn } from "cn";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { Explanation } from "@/lib/ipo";

/** Building blocks shared by the IPO launch screen's form and outcomes (T64). */

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

export function IpoLoading({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
    >
      <Spinner aria-hidden="true" role="presentation" />
      {children}
    </div>
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
