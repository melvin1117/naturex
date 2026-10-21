"use client";

import { RouteError } from "@/components/route-error";
import { MAIN_ID } from "@/components/shell/skip-link";

/** A crash anywhere without a nearer boundary: it replaces the app's shell, so it's the main. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id={MAIN_ID} tabIndex={-1} className="flex-1 outline-none">
      <RouteError reset={reset} digest={error.digest} />
    </main>
  );
}
