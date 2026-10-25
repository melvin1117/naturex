import { RequireAccount } from "@/components/require-account";

/** Reviews (`/admin/verifications`): the Reviewer's. */
export default function ReviewsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequireAccount admin>{children}</RequireAccount>;
}
