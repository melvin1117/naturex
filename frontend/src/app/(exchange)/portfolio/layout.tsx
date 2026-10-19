import { RequireAccount } from "@/components/require-account";

export default function PortfolioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequireAccount>{children}</RequireAccount>;
}
