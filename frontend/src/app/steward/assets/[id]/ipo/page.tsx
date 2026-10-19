import type { Metadata } from "next";

import { IpoLaunchScreen } from "@/components/ipo-launch-screen";
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
      <IpoLaunchScreen assetId={id} />
    </RequireAccount>
  );
}
