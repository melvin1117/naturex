import { redirect } from "next/navigation";

import { stewardHomeHref } from "@/lib/listing/links";
import { sandboxHref } from "@/lib/sandbox";

/** A community's sites are on its page now (ADR-0008); old links land there. */
export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { community } = await searchParams;
  redirect(
    sandboxHref(
      stewardHomeHref(typeof community === "string" ? community : null),
    ),
  );
}
