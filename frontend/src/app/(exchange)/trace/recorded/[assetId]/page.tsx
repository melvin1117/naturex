import type { Metadata } from "next";

import { RecordedTracePage } from "@/components/trace/run-trace-page";

export const metadata: Metadata = { title: "How it was rated (recorded run)" };

export default async function RecordedTraceRoute({
  params,
}: {
  params: Promise<{ assetId: string }>;
}) {
  const { assetId } = await params;
  return <RecordedTracePage assetId={assetId} />;
}
