import { StewardPanel } from "@/components/steward/panel";
import type { Wallet } from "@/lib/api/types";
import { moneyText } from "@/lib/trade";

/**
 * The community's money (T63), every figure from `GET /communities/{id}/summary`: the
 * community fund (`community_wallet`) is what supporters paid in the opening offer plus the
 * quarterly payouts; the payouts on the units the community keeps (the API's retained-stake
 * dividends, held by its treasury) are a separate line. In steward words
 * (docs/design/ux-writing.md §7).
 */
export function WalletCard({
  wallet,
  title = "Community fund",
}: {
  wallet: Wallet;
  title?: string;
}) {
  return (
    <StewardPanel title={title}>
      <p className="text-xs text-muted-foreground">Balance</p>
      <p className="tabular mt-1 text-4xl font-light tracking-tight">
        {moneyText(wallet.balance)}
      </p>
      <dl className="mt-5 space-y-2 text-sm">
        <Line label="From supporters" value={wallet.ipo_proceeds}>
          What supporters paid for units in the opening offer
        </Line>
        <Line label="Quarterly payouts" value={wallet.community_fund_payouts}>
          The community&apos;s half of each quarter&apos;s simulated revenue
        </Line>
        <Line label="Community fund balance" value={wallet.balance} total />
        <Line
          label="Payouts on the units you kept"
          value={wallet.retained_dividends}
        >
          Paid for the units your community keeps, held outside the fund
        </Line>
        <Line label="Total received" value={wallet.total_received} total />
      </dl>
    </StewardPanel>
  );
}

function Line({
  label,
  value,
  total = false,
  children,
}: {
  label: string;
  value: string;
  total?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={
        total
          ? "flex items-baseline justify-between gap-4 border-t border-border pt-2 font-medium"
          : "flex items-baseline justify-between gap-4"
      }
    >
      <dt className="min-w-0">
        {label}
        {children && (
          <span className="block text-xs font-normal text-muted-foreground">
            {children}
          </span>
        )}
      </dt>
      <dd className="tabular shrink-0">{moneyText(value)}</dd>
    </div>
  );
}
