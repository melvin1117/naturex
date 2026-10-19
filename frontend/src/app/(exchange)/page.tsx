import { Suspense } from "react";

import { Marketplace } from "@/components/proto/marketplace";

export default function MarketplacePage() {
  return (
    // The grade filter and sort live in the URL (useSearchParams).
    <Suspense>
      <Marketplace />
    </Suspense>
  );
}
