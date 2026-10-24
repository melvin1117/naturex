import { PrototypeHeaderTools } from "@/components/proto/header-tools";
import { SiteFooter } from "@/components/proto/site-footer";
import { AppHeader } from "@/components/shell/app-header";
import { MAIN_ID } from "@/components/shell/skip-link";

/** WildWorth Exchange (`/`): for investors and everyone (ADR-0005 §5). */
export default function ExchangeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AppHeader
        app="exchange"
        tools={<PrototypeHeaderTools app="exchange" />}
      />
      <main id={MAIN_ID} tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
