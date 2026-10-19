import type { Metadata } from "next";
import { Suspense } from "react";

import { DevTrade } from "@/components/dev-trade";
import { AppHeader } from "@/components/proto/app-header";

export const metadata: Metadata = {
  title: "Trade panel",
  robots: { index: false },
};

/**
 * The real trade panel on the live API (T18), until T22's asset page (`/asset/<uuid>`) is
 * merged and shows it. Delete this route then.
 */
export default function DevTradePage() {
  return (
    <>
      <AppHeader app="exchange" />
      <main className="flex-1">
        <Suspense>
          <DevTrade />
        </Suspense>
      </main>
    </>
  );
}
