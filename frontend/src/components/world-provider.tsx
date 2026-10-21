"use client";

import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  DataLayerProvider,
  useDataLayer,
  type DataLayer,
} from "@/lib/data-layer";
import { useWorld } from "@/lib/hooks";

/**
 * Provides the data layer and opens the visitor's sandbox world (`GET /world`, once) as soon
 * as the app loads. Children always render, so server HTML and static pages are unaffected;
 * any request made before the world exists waits for it (the client middleware and the
 * event hub both call `session.ensure()`). Wrap data-driven sections in `<WorldGate>` to show
 * a loading or error state until the world is ready.
 */
export function WorldProvider({
  children,
  dataLayer,
}: {
  children: ReactNode;
  /** Tests inject their own; the app uses the tab-wide layer. */
  dataLayer?: DataLayer;
}) {
  return (
    <DataLayerProvider value={dataLayer}>
      <WorldBootstrap />
      {children}
    </DataLayerProvider>
  );
}

function WorldBootstrap() {
  const { session } = useDataLayer();
  useEffect(() => {
    session.ensure().catch(() => undefined);
  }, [session]);
  return null;
}

/**
 * Renders `children` only once the visitor's world exists; until then an accessible loading
 * state (`fallback`, e.g. the page's skeleton, else a status line), or an error with a retry
 * if the world can't be opened (e.g. the backend is down).
 */
export function WorldGate({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { status, error, retry } = useWorld();

  if (status === "ready") return children;

  if (status === "error") {
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>We couldn&apos;t open your demo world</AlertTitle>
        <AlertDescription>
          <p>{error?.message ?? "Something went wrong. Try again."}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void retry()}
          >
            <RefreshCwIcon aria-hidden="true" />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (fallback) return fallback;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
    >
      <Spinner aria-hidden="true" role="presentation" />
      Opening your demo world…
    </div>
  );
}
