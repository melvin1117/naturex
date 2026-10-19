import { AppHeader } from "@/components/proto/app-header";
import { SiteFooter } from "@/components/proto/site-footer";
import { RequireAccount } from "@/components/require-account";

export default function StewardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AppHeader app="steward" />
      <main className="flex-1">
        <RequireAccount allowPrototypeDemo>{children}</RequireAccount>
      </main>
      <SiteFooter />
    </>
  );
}
