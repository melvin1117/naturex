"use client";

import { AskBeaButton } from "@/components/bea/ask-bea-button";
import { usePathname } from "@/lib/nav";
import { usePrototype } from "@/lib/prototype/store";
import { traceAssetFromPath } from "@/lib/run-trace";

/**
 * Bea, one tap from every page of the sandbox: a floating button that opens her sheet. Each
 * opening starts a fresh chat with starter questions for the page you're on (a site's page
 * asks about that site; anywhere else, about every site).
 */
export function BeaFab() {
  const pathname = usePathname();
  const { openCopilot } = usePrototype();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 sm:right-6 sm:bottom-6">
      <AskBeaButton
        onClick={() => openCopilot(traceAssetFromPath(pathname))}
        className="pointer-events-auto h-12 pr-4 pl-1.5 text-[14px] shadow-lift max-sm:size-12 max-sm:p-2"
      />
    </div>
  );
}
