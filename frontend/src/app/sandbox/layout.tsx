import type { Metadata } from "next";

import { SandboxGate } from "@/components/sandbox/sandbox-gate";

export const metadata: Metadata = {
  title: { default: "Your sandbox", template: "%s · Sandbox · NatureX" },
};

/** `/sandbox/*`: the real app's screens in the visitor's private sandbox (lib/sandbox.ts). */
export default function SandboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SandboxGate>{children}</SandboxGate>;
}
