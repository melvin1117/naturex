import { ReviewerGate } from "@/components/reviewer-gate";

/** Reviews (`/admin/verifications`): the Reviewer's. */
export default function ReviewsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ReviewerGate>{children}</ReviewerGate>;
}
