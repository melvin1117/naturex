import { AppHeader } from "@/components/proto/app-header";
import { SiteFooter } from "@/components/proto/site-footer";
import { RequireAccount } from "@/components/require-account";
import { MAIN_ID } from "@/components/skip-link";
import {
  StewardCommunityProvider,
  StewardGate,
} from "@/components/steward-community";

/**
 * NatureX Steward (`/steward`): for community owners and stewards (ADR-0005 §5). A signed-in
 * account without a community sees how to start one instead of the pages.
 */
export default function StewardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StewardCommunityProvider>
      <AppHeader app="steward" />
      <main id={MAIN_ID} tabIndex={-1} className="flex-1 outline-none">
        <RequireAccount allowPrototypeDemo>
          <StewardGate>{children}</StewardGate>
        </RequireAccount>
      </main>
      <SiteFooter />
    </StewardCommunityProvider>
  );
}
