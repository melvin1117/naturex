import type { Metadata } from "next";

import { PageStub } from "@/components/page-stub";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

export default function AdminPage() {
  return (
    <PageStub
      title="Time Machine"
      description="Advance a quarter, inject events and reset the demo."
      builtIn={["T38", "T43"]}
    />
  );
}
