import type { Metadata } from "next";

import { PageStub } from "@/components/page-stub";

export const metadata: Metadata = { title: "Asset" };

export default async function AssetPage({ params }: PageProps<"/asset/[id]">) {
  const { id } = await params;
  return (
    <PageStub
      title={`Asset ${id}`}
      description="Rating report, value breakdown, price chart, trade panel, alerts and Copilot."
      builtIn={["T12", "T23"]}
    />
  );
}
