"use client";

import { RouteError } from "@/components/route-error";

/** A crash in the control room: shown inside its header and main, with a way back to it. */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      reset={reset}
      digest={error.digest}
      home={{ href: "/admin", label: "Back to the Time Machine" }}
    />
  );
}
