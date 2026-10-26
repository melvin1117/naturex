"use client";

import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApiError } from "@/lib/api/errors";

/** A trace that couldn't load, on the machine layer, with a retry when one can help. */
export function TraceError({
  title,
  error,
  retry,
}: {
  title: string;
  error: ApiError | null;
  retry?: () => unknown;
}) {
  return (
    <div
      role="alert"
      className="mt-4 rounded-2xl bg-clay/20 px-4 py-3 text-sm text-machine-ink"
    >
      <p className="font-medium">{title}</p>
      {error && <p className="mt-0.5 text-machine-muted">{error.message}</p>}
      {retry && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 border-machine-line bg-transparent text-machine-ink hover:bg-machine-line"
          onClick={() => void retry()}
        >
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}
