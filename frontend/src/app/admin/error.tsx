"use client";

import { RouteError } from "@/components/route-error";

/** A crash in the control room: shown inside its header and main, with a way back to it. */
export default function AdminError({ reset }: { reset: () => void }) {
  return (
    <RouteError
      reset={reset}
      home={{ href: "/admin", label: "Back to the Time Machine" }}
    />
  );
}
