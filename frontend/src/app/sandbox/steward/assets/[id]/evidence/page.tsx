import type { Metadata } from "next";

import { FieldEvidenceScreen } from "@/components/evidence/field-evidence-screen";

export const metadata: Metadata = { title: "Field evidence" };

/**
 * Field evidence for the community's owner and stewards (T40, story A4): upload geotagged
 * photos of the listing's land and read each photo's checks and the confidence effect.
 */
export default async function EvidencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <FieldEvidenceScreen assetId={id} />;
}
