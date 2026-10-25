import { ArrowLeft, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import Link from "@/components/app-link";
import type { ReactNode, Ref } from "react";
import { cn } from "cn";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Building blocks for a community's focused screens (T64): the shell, card and error alert the
 * field evidence screen uses.
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
