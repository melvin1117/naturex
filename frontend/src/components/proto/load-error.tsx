import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ApiError } from "@/lib/api/errors";

/** A failed API read: what failed, the API's safe message and a retry. */
export function LoadError({
  title,
  error,
  retry,
}: {
  title: string;
  error: ApiError;
  retry: () => Promise<void>;
}) {
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
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
