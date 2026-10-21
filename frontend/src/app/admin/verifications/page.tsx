import type { Metadata } from "next";

import {
  ReviewQueueScreen,
  reviewView,
} from "@/components/verification/review-queue-screen";

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
