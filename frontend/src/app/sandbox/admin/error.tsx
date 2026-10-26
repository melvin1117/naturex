"use client";

import { RouteError } from "@/components/route-error";

/** A crash on the Time Machine or Reviews pages: shown inside the shell, with a way back. */
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
