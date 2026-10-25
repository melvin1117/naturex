import { redirect } from "next/navigation";

import { ipoHref } from "@/lib/listing/links";
import { sandboxHref } from "@/lib/sandbox";

/** The opening offer is the listing flow's Offer step now (ADR-0008 §5); old links land there. */
export default async function IpoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const community =
    typeof query.community === "string" ? query.community : null;
  redirect(sandboxHref(ipoHref(id, community)));
}
