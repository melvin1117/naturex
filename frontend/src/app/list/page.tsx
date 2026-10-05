import type { Metadata } from "next";

import { PageStub } from "@/components/page-stub";

export const metadata: Metadata = { title: "List land" };

export default function ListPage() {
  return (
    <PageStub
      title="List your land"
      description="Draw the land on a map, add details and watch the AI rating run."
      builtIn={["T33"]}
    />
  );
}
