"use client";

import { useState } from "react";

import { AccountCopilot } from "@/components/account-copilot";
import { AskBeaButton } from "@/components/bea/ask-bea-button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { usePathname } from "@/lib/nav";
import { traceAssetFromPath } from "@/lib/run-trace";

/**
 * Bea, one tap from every page of the sandbox: a floating button that opens her sheet. Each
 * opening starts a fresh chat with starter questions for the page you're on (a site's page
 * asks about that site; anywhere else, about every site).
 */
export function BeaFab() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <div className="pointer-events-none fixed right-4 bottom-4 z-40 sm:right-6 sm:bottom-6">
        {/* A real trigger: focus comes back to the button when the sheet closes. */}
        <SheetTrigger asChild>
          <AskBeaButton className="pointer-events-auto h-12 pr-4 pl-1.5 text-[14px] shadow-lift max-sm:size-12 max-sm:p-2" />
        </SheetTrigger>
      </div>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        {/* The sheet mounts its content only while open: every opening is a fresh chat. */}
        <AccountCopilot
          pageAssetId={traceAssetFromPath(pathname)}
          onNavigate={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}
