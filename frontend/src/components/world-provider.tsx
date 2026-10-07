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
 * Opens the visitor's sandbox world (`GET /world`, once) and renders `children` only when it
 * exists, so no screen can fire a request before the world cookie is set.
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
      <WorldGate>{children}</WorldGate>
    </DataLayerProvider>
  );
}

function WorldGate({ children }: { children: ReactNode }) {
  const { session } = useDataLayer();
  const { status, error, retry } = useWorld();

  useEffect(() => {
    session.ensure().catch(() => undefined);
  }, [session]);

  if (status === "ready") return children;

  if (status === "error") {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-16">
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
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-muted-foreground"
    >
      <Spinner aria-hidden="true" role="presentation" />
      Opening your demo world…
    </div>
  );
}
