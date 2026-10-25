import { Suspense } from "react";

import { MarketplaceSkeleton } from "@/components/page-skeletons";
import { Marketplace } from "@/components/proto/marketplace";

export default function MarketplacePage() {
  return (
    // The grade filter and sort live in the URL (useSearchParams), so the static HTML shows
    // the page's shape until the client renders it.
    <Suspense fallback={<MarketplaceSkeleton />}>
      <Marketplace />
    </Suspense>
  );
}
