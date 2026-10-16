import { AppHeader } from "@/components/proto/app-header";
import { SiteFooter } from "@/components/proto/site-footer";

export default function StewardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AppHeader app="steward" />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </>
  );
}
