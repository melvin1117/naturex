import { AppHeader } from "@/components/proto/app-header";
import { SiteFooter } from "@/components/proto/site-footer";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AppHeader app="admin" />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </>
  );
}
