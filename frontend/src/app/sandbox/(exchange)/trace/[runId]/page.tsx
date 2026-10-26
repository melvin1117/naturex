import type { Metadata } from "next";

import { RunTracePage } from "@/components/trace/run-trace-page";

export const metadata: Metadata = { title: "How it was rated" };

export default async function TracePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <RunTracePage runId={runId} />;
}
