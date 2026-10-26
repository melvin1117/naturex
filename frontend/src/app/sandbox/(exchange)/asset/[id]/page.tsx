import type { Metadata } from "next";
import { Suspense } from "react";

import { AssetView } from "@/components/proto/asset-view";

// The name lives in the visitor's sandbox: the page sets its own title once the site loads.
export const metadata: Metadata = { title: "Site" };

export default async function AssetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense>
      <AssetView id={id} />
    </Suspense>
  );
}
