import type { Metadata } from "next";
import { Suspense } from "react";

import { AssetView } from "@/components/proto/asset-view";
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
      <AssetView id={id} />
    </Suspense>
  );
}
