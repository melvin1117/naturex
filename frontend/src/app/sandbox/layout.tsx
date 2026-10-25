import type { Metadata } from "next";

import { SandboxGate } from "@/components/sandbox/sandbox-gate";

export const metadata: Metadata = {
  title: { default: "Marketplace", template: "%s · WildWorth" },
  // Opening a sandbox page creates a sandbox: keep crawlers out of the per-hour budget.
  robots: { index: false, follow: false },
};

/** `/sandbox/*`: WildWorth itself, in the visitor's private sandbox (lib/sandbox.ts); no sign-up. */
export default function SandboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SandboxGate>{children}</SandboxGate>;
}
