import type { Metadata } from "next";

import { RequireAccount } from "@/components/require-account";
import { StewardVerifyScreen } from "@/components/verification/steward-verify-screen";

export const metadata: Metadata = { title: "Verify your listing" };

/**
 * Listing verification for the community's owner and stewards (T70, ADR-0006): upload
 * documents, submit them, read the checks and the decision. Real accounts only.
 */
export default async function VerifyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <RequireAccount>
      <StewardVerifyScreen assetId={id} />
    </RequireAccount>
  );
}
