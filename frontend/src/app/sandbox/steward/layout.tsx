import { RequireAccount } from "@/components/require-account";
import {
  CommunityBar,
  StewardCommunityProvider,
  StewardGate,
} from "@/components/shell/steward-community";

/**
 * Communities (`/steward`): the communities you're in, their land and listings. Someone in no
 * community sees how to start one instead of the pages.
 */
export default function StewardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StewardCommunityProvider>
      <RequireAccount allowPrototypeDemo>
        <StewardGate>
          <CommunityBar />
          {children}
        </StewardGate>
      </RequireAccount>
    </StewardCommunityProvider>
  );
}
