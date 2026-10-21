import type { Metadata } from "next";
import { Suspense } from "react";

import { ReviewQueueScreen } from "@/components/verification/review-queue-screen";

export const metadata: Metadata = { title: "Verifications" };

export default function VerificationQueuePage() {
  // The screen reads its view from the address (useSearchParams), so it renders on the client.
  return (
    <Suspense>
      <ReviewQueueScreen />
    </Suspense>
  );
}
