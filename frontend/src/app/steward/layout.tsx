import { PrototypeHeaderTools } from "@/components/proto/header-tools";
import { SiteFooter } from "@/components/proto/site-footer";
import { RequireAccount } from "@/components/require-account";
import { AppHeader } from "@/components/shell/app-header";
import { MAIN_ID } from "@/components/shell/skip-link";
import {
  StewardCommunityProvider,
  StewardGate,
} from "@/components/shell/steward-community";

/**
 * WildWorth Stewards (`/steward`): for community owners and stewards (ADR-0005 §5). A signed-in
 * account without a community sees how to start one instead of the pages.
 */
export default function StewardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StewardCommunityProvider>
      <AppHeader app="steward" tools={<PrototypeHeaderTools app="steward" />} />
      <main id={MAIN_ID} tabIndex={-1} className="flex-1 outline-none">
        <RequireAccount allowPrototypeDemo>
          <StewardGate>{children}</StewardGate>
        </RequireAccount>
      </main>
      <SiteFooter />
    </StewardCommunityProvider>
  );
}
