import type { Metadata } from "next";

import { PageStub } from "@/components/page-stub";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <PageStub
      title="Portfolio"
      description="Your holdings, profit and loss, and the nature impact they fund."
      builtIn={["T18", "T44"]}
    />
  );
}
