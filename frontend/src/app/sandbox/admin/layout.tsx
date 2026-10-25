import { RequireAccount } from "@/components/require-account";

/** The Time Machine page (`/admin`): anyone in the sandbox. Reviews have their own gate. */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequireAccount>{children}</RequireAccount>;
}
