import { Panel } from "@/components/proto/report-panels";
import type { Wallet } from "@/lib/api/types";
import { moneyText } from "@/lib/trade";

/**
 * The community's money (T63), every figure from `GET /communities/{id}/summary`: the
 * community fund (the treasury's `community_wallet`) is IPO proceeds plus community-fund
 * payouts; the retained stake's dividends are paid to the treasury on top. Play money.
 */
export function WalletCard({
  wallet,
  title = "Community fund",
}: {
  wallet: Wallet;
  title?: string;
}) {
  return (
    <Panel title={title} aria-label={title}>
      <p className="text-xs text-muted-foreground">
        Treasury balance · play money
      </p>
      <p className="tabular mt-1 text-4xl font-light tracking-tight">
        {moneyText(wallet.balance)}
      </p>
      <dl className="mt-5 space-y-2 text-sm">
        <Line label="IPO proceeds" value={wallet.ipo_proceeds}>
          Paid by supporters for units from the opening offer
        </Line>
        <Line
          label="Community-fund payouts"
          value={wallet.community_fund_payouts}
        >
          The community&apos;s half of each quarter&apos;s simulated revenue
        </Line>
        <Line label="Community fund" value={wallet.balance} total />
        <Line
          label="Retained-stake dividends"
          value={wallet.retained_dividends}
        >
          Paid to the treasury for the units it keeps
        </Line>
        <Line label="Total received" value={wallet.total_received} total />
      </dl>
    </Panel>
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
