import { RequireAccount } from "@/components/require-account";

/** Reviews and the Time Machine page (`/admin`): the Reviewer's. */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequireAccount admin>{children}</RequireAccount>;
}
