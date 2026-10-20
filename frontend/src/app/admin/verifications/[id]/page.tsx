import type { Metadata } from "next";

import { ListingReviewScreen } from "@/components/verification/listing-review-screen";

export const metadata: Metadata = { title: "Verification review" };

export default async function VerificationReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ListingReviewScreen assetId={id} />;
}
