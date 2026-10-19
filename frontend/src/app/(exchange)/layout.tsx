import { AppHeader } from "@/components/proto/app-header";
import { SiteFooter } from "@/components/proto/site-footer";
import { MAIN_ID } from "@/components/skip-link";

/** NatureX Exchange (`/`): for investors and everyone (ADR-0005 §5). */
export default function ExchangeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AppHeader app="exchange" />
      <main id={MAIN_ID} tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
