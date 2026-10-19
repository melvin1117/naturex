import { PrototypeHeaderTools } from "@/components/proto/header-tools";
import { SiteFooter } from "@/components/proto/site-footer";
import { RequireAccount } from "@/components/require-account";
import { AppHeader } from "@/components/shell/app-header";
import { MAIN_ID } from "@/components/shell/skip-link";

/** The control room (`/admin`): platform admins only (ADR-0005 §5). */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AppHeader app="admin" tools={<PrototypeHeaderTools app="admin" />} />
      <main id={MAIN_ID} tabIndex={-1} className="flex-1 outline-none">
        <RequireAccount admin>{children}</RequireAccount>
      </main>
      <SiteFooter />
    </>
  );
}
