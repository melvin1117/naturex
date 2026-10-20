import type { Metadata } from "next";

import { ReviewQueueScreen } from "@/components/verification/review-queue-screen";

export const metadata: Metadata = { title: "Verification queue" };

export default function VerificationQueuePage() {
  return <ReviewQueueScreen />;
}
