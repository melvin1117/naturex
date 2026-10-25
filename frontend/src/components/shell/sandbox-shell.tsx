import type { ReactNode } from "react";

import { BeaFab } from "@/components/bea/bea-fab";
import { SandboxFooter } from "@/components/shell/sandbox-footer";
import { SandboxHeader } from "@/components/shell/sandbox-header";
import { MAIN_ID } from "@/components/shell/skip-link";

/** Every sandbox page: the bar, the page, a quiet footer and Bea, one tap away. */
export function SandboxShell({ children }: { children: ReactNode }) {
  return (
    <>
      <SandboxHeader />
      <main id={MAIN_ID} tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SandboxFooter />
      <BeaFab />
    </>
  );
}
