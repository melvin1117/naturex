import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { DevTrade } from "@/components/dev-trade";
import { AppHeader } from "@/components/proto/app-header";
import { devRoutesEnabled } from "@/lib/dev-routes";

export const metadata: Metadata = {
  title: "Trade panel",
  robots: { index: false },
};

// Decide per request, so NATUREX_DEV_ROUTES is read at runtime rather than baked in at build.
export const dynamic = "force-dynamic";

/**
 * The real trade panel on the live API (T18), until T22's asset page (`/asset/<uuid>`) is
 * merged and shows it. Delete this route then. A 404 in production unless
 * `NATUREX_DEV_ROUTES=true`.
 */
export default function DevTradePage() {
  if (!devRoutesEnabled()) notFound();
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
