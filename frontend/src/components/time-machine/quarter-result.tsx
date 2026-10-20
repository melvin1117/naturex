import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SimulateQuarter } from "@/lib/api/types";
import { quarterLabel } from "@/lib/prototype/format";
import {
  ASSET_STATUS_LABEL,
  detailText,
  PAYOUT_LABEL,
  stoppedText,
} from "@/lib/time-machine";

import { changeCells } from "./rating-change";

function Count({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular text-2xl font-light">{n}</dd>
    </div>
  );
}

/** What a quarter did: totals, then per site before → after, alerts and payout. */
export function QuarterResult({ result }: { result: SimulateQuarter }) {
  const stopped = stoppedText(result.stopped);
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">
          {quarterLabel(result.period)}: {result.scenario}
        </h3>
        <Badge variant="outline">Simulated · {result.data_version}</Badge>
        {result.replayed && (
          <Badge variant="secondary">Replayed: only unfinished work ran</Badge>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Count n={result.assets_rerated} label="Re-rated" />
        <Count n={result.assets_skipped} label="Skipped" />
        <Count n={result.assets_failed} label="Failed" />
        <Count n={result.alerts} label="Alerts sent" />
        <Count n={result.payouts} label="Payouts" />
      </dl>
      {stopped && (
        <p role="alert" className="text-sm text-destructive">
          {stopped}
        </p>
      )}
      {result.assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No listed sites to re-rate in this world.
        </p>
      ) : (
        <div
          className="-mx-6 overflow-x-auto px-6"
          // Scrolls sideways on a phone: focusable so the keyboard can scroll it too.
          tabIndex={0}
          role="group"
          aria-label="Results by site"
        >
          <Table>
            <caption className="sr-only">
              Each listed site before and after {quarterLabel(result.period)}
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead>Price</TableHead>
                <TableHead className="text-right">Alerts</TableHead>
                <TableHead>Payout</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.assets.map((a) => {
                const cells = changeCells(a.before, a.after);
                const detail = detailText(a.detail);
                return (
                  <TableRow key={a.asset_id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/asset/${a.asset_id}?tab=price`}
                        className="hover:underline"
                      >
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {ASSET_STATUS_LABEL[a.status] ?? a.status}
                      {detail && (
                        <span className="block text-xs text-muted-foreground">
                          {detail}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{cells.health}</TableCell>
                    <TableCell>{cells.grade}</TableCell>
                    <TableCell>{cells.price}</TableCell>
                    <TableCell className="tabular text-right">
                      {a.alert_ids?.length ?? 0}
                    </TableCell>
                    <TableCell>
                      {a.payout ? (
                        PAYOUT_LABEL[a.payout]
                      ) : (
                        <span className="text-muted-foreground">No payout</span>
                      )}
                      {a.payout_detail && (
                        <span className="block text-xs text-muted-foreground">
                          {detailText(a.payout_detail)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
