import type { Metadata } from "next";
import { Suspense } from "react";

import { AssetView } from "@/components/proto/asset-view";
import { PrototypeAssetView } from "@/components/proto/prototype-asset-view";
import { isApiAssetId } from "@/lib/asset-detail";
import { SITE_DATA, SITE_META } from "@/lib/prototype/data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const meta = SITE_META.find((m) => m.id === id);
  const name = meta
    ? SITE_DATA.find((s) => s.key === meta.key)?.name
    : undefined;
  // Real assets set their own title once loaded (the name lives in the visitor's world).
  return { title: name ?? "Site" };
}

export default async function AssetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense>
      {isApiAssetId(id) ? (
        <AssetView id={id} />
      ) : (
        <PrototypeAssetView id={id} />
      )}
    </Suspense>
  );
}
