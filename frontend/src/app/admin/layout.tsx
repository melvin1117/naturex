import { AppHeader } from "@/components/proto/app-header";
import { SiteFooter } from "@/components/proto/site-footer";
import { RequireAccount } from "@/components/require-account";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AppHeader app="admin" />
      <main className="flex-1">
        <RequireAccount admin>{children}</RequireAccount>
      </main>
      <SiteFooter />
    </>
  );
}
