import type { Metadata } from "next";

import { ReviewQueueScreen } from "@/components/verification/review-queue-screen";
import { reviewView } from "@/lib/verification";

export const metadata: Metadata = { title: "Verifications" };

export default async function VerificationQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { view } = await searchParams;
  return (
    <ReviewQueueScreen
      initialView={reviewView(typeof view === "string" ? view : null)}
    />
  );
}
