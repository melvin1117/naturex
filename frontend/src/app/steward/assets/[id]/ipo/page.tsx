import type { Metadata } from "next";

import { IpoLaunch } from "@/components/ipo-launch";
import { RequireAccount } from "@/components/require-account";

export const metadata: Metadata = { title: "Launch the opening offer" };

/**
 * The opening offer (IPO) launch screen (T64): owner only. Steward home and the listing flow
 * link here; it also works opened directly. Real accounts only, never the scripted demo.
 */
export default async function IpoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <RequireAccount>
      <IpoLaunch assetId={id} />
    </RequireAccount>
  );
}
