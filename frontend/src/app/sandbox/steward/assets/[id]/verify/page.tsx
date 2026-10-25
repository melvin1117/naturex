import { redirect } from "next/navigation";

import { verifyHref } from "@/lib/listing/links";
import { sandboxHref } from "@/lib/sandbox";

/** Land documents are the listing flow's Prove step now (ADR-0008 §5); old links land there. */
export default async function VerifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const community =
    typeof query.community === "string" ? query.community : null;
  redirect(sandboxHref(verifyHref(id, community)));
}
