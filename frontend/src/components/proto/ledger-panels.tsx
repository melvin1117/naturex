"use client";

import { AlertTriangle, ShieldCheck, ShieldX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";

import { MachineRowsSkeleton } from "@/components/page-skeletons";
import { LoadError } from "@/components/proto/load-error";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLedger, useVerifyLedger } from "@/lib/hooks";
import { date } from "@/lib/prototype/format";
import { verify, type VerifyResult } from "@/lib/prototype/ledger";
import { usePrototype } from "@/lib/prototype/store";
import { tamperLedger, type Site } from "@/lib/prototype/world";
import { ledgerEntryId } from "@/lib/verification";

export type LedgerRow = {
  seq: number;
  kind: string;
  date: string;
  hash: string;
  payload: Record<string, unknown>;
};

export type LedgerCheck = {
  valid: boolean;
  entries: number;
  brokenAt: number | null;
  /** Where the hashes were recomputed, or why the chain can't be trusted. */
  note: string;
};

function payloadText(payload: Record<string, unknown>) {
  return Object.entries(payload)
    .map(
      ([k, v]) =>
        `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`,
    )
    .join(" · ");
}

/** The Record (the hash-chained ledger): entries newest first, the verify result and the caller's actions. */
export function LedgerPanel({
  entries,
  check,
  actions,
  tamperedAt,
  highlightedAt,
  empty = "No entries in the Record yet.",
  loading = false,
}: {
  entries: LedgerRow[];
  check: LedgerCheck | null;
  actions: React.ReactNode;
  tamperedAt?: number;
  /** The entry a link pointed at (`#ledger-entry-<seq>`), outlined. */
  highlightedAt?: number | null;
  empty?: string;
  /** The entries are on their way: rows in their shape, under the real heading. */
  loading?: boolean;
}) {
  return (
    <section className="rounded-3xl bg-machine p-6 text-machine-ink shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h3 className="font-serif text-3xl">The Record</h3>
          <p className="mt-1 text-sm text-machine-muted">
            Append-only and hash-chained. Each entry stores sha256 of its
            content, kind, sequence number and the previous entry&apos;s hash,
            so changing any old entry breaks every link after it. No tokens, no
            trading: it&apos;s a public record.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
      <div aria-live="polite">
        {check && (
          <div
            role="status"
            className={cn(
              "ww-rise mt-5 flex items-start gap-3 rounded-2xl p-4",
              check.valid ? "bg-lime/15" : "bg-clay/25",
            )}
          >
            {check.valid ? (
              <ShieldCheck
                className="mt-0.5 size-5 text-lime"
                aria-hidden="true"
              />
            ) : (
              <ShieldX className="mt-0.5 size-5 text-clay" aria-hidden="true" />
            )}
            <div className="text-sm">
              <div className="font-medium">
                {check.valid
                  ? check.entries === 1
                    ? "Chain intact: its 1 entry verified."
                    : `Chain intact: all ${check.entries} entries verified.`
                  : check.brokenAt !== null
                    ? `Record broken at entry #${check.brokenAt}.`
                    : "The chain doesn't verify."}
              </div>
              <div className="text-machine-muted">{check.note}</div>
            </div>
          </div>
        )}
      </div>
      {loading ? (
        <MachineRowsSkeleton label="Loading the Record…" className="mt-5" />
      ) : entries.length === 0 ? (
        <p className="mt-5 text-sm text-machine-muted">{empty}</p>
      ) : (
        <ol className="mt-5 space-y-2">
          {[...entries].reverse().map((e) => (
            <li
              key={e.seq}
              id={ledgerEntryId(e.seq)}
              tabIndex={-1}
              className={cn(
                "scroll-mt-24 rounded-2xl bg-machine-raised px-4 py-3 outline-none",
                tamperedAt === e.seq && "ring-2 ring-clay",
                highlightedAt === e.seq && "ring-2 ring-lime",
              )}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="tabular font-mono text-xs text-machine-muted">
                  #{e.seq}
                </span>
                <span className="font-medium capitalize">
                  {e.kind.replaceAll("_", " ")}
                </span>
                <span className="text-xs text-machine-muted">
                  {date(e.date)}
                </span>
                {tamperedAt === e.seq && (
                  <span className="rounded-full bg-clay px-2 py-0.5 text-[11px] font-semibold text-white">
                    Edited
                  </span>
                )}
                <span
                  className="ml-auto font-mono text-[11px] text-machine-muted"
                  title={e.hash}
                >
                  {e.hash.slice(0, 10)}…{e.hash.slice(-6)}
                </span>
              </div>
              <div className="mt-1.5 font-mono text-[11px] break-all text-machine-muted">
                {payloadText(e.payload)}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export const LEDGER_OUTLINE =
  "border-machine-line bg-transparent text-machine-ink hover:bg-machine-raised hover:text-machine-ink";

function prototypeCheck(result: VerifyResult): LedgerCheck {
  return result.valid
    ? {
        valid: true,
        entries: result.entries,
        brokenAt: null,
        note: "Every hash was recomputed in your browser and matches.",
      }
    : {
        valid: false,
        entries: result.entries,
        brokenAt: result.brokenAt,
        note: `${result.reason} This entry and every entry after it can't be trusted.`,
      };
}

/** The prototype's ledger, verified in the browser, with the tamper demo. */
export function LedgerTab({ site }: { site: Site }) {
  const { world, act } = usePrototype();
  const chain = world.ledger[site.id] ?? [];
  const [result, setResult] = useState<VerifyResult | null>(null);
  const tamperedAt = world.tampered[site.id];
  return (
    <div className="space-y-6">
      <LedgerPanel
        entries={chain}
        check={result && prototypeCheck(result)}
        tamperedAt={tamperedAt}
        actions={
          <>
            <Button
              variant="on-image"
              onClick={() => setResult(verify(chain))}
              data-tour="ledger-verify"
            >
              <ShieldCheck aria-hidden="true" />
              Verify the Record
            </Button>
            <Button
              variant="outline"
              className={LEDGER_OUTLINE}
              onClick={() => {
                act((w) => tamperLedger(w, site.id));
                setResult(null);
              }}
              disabled={tamperedAt !== undefined}
              data-tour="ledger-tamper"
            >
              <AlertTriangle aria-hidden="true" />
              Tamper demo
            </Button>
          </>
        }
      />
    </div>
  );
}

/** The real asset's ledger: entries from the API, verified on the server. */
export function ApiLedgerTab({ assetId }: { assetId: string }) {
  const ledger = useLedger(assetId);
  const verifier = useVerifyLedger(assetId);
  const entries = useMemo(
    () =>
      (ledger.data ?? []).map((e) => ({
        seq: e.seq,
        kind: e.kind,
        date: e.created_at,
        hash: e.hash,
        payload: e.payload,
      })),
    [ledger.data],
  );
  // A result describes the chain it checked: drop it once the chain itself changes (a new
  // entry, a reset world). Verifying refetches the same chain, which keeps the result.
  const chainKey = ledger.data
    ? `${ledger.data.length}:${ledger.data.at(-1)?.hash ?? ""}`
    : null;
  const resetVerify = verifier.reset;
  useEffect(() => {
    resetVerify();
  }, [chainKey, resetVerify]);
  const highlighted = useLinkedEntry(ledger.data !== undefined);

  if (!ledger.data && ledger.error)
    return (
      <LoadError
        title="We couldn't load the Record"
        error={ledger.error}
        retry={ledger.refetch}
      />
    );
  if (!ledger.data)
    return (
      <LedgerPanel
        entries={[]}
        check={null}
        loading
        actions={
          <Button variant="on-image" disabled>
            <ShieldCheck aria-hidden="true" />
            Verify the Record
          </Button>
        }
      />
    );

  const result = verifier.data;
  return (
    <div className="space-y-3">
      <LedgerPanel
        entries={entries}
        highlightedAt={highlighted}
        check={
          result
            ? {
                valid: result.valid,
                entries: result.entries,
                brokenAt: result.broken_at,
                note: result.valid
                  ? `The server recomputed every hash from the stored entries; the chain head is ${result.head?.slice(0, 10) ?? "—"}…`
                  : "The server recomputed the hashes and this entry no longer matches. It and every entry after it can't be trusted.",
              }
            : null
        }
        actions={
          <Button
            variant="on-image"
            onClick={() => void verifier.mutate(undefined)}
            disabled={verifier.isPending}
          >
            {verifier.isPending ? (
              <Spinner aria-hidden="true" role="presentation" />
            ) : (
              <ShieldCheck aria-hidden="true" />
            )}
            Verify the Record
          </Button>
        }
      />
      {verifier.error && (
        <p role="alert" className="text-sm text-clay-ink">
          {verifier.error.message}
        </p>
      )}
    </div>
  );
}

/**
 * The entry the page's hash names (`#ledger-entry-<seq>`, e.g. from "How this listing was
 * verified"), scrolled to and focused once the entries are on screen, and again whenever the
 * hash changes while the ledger is open.
 */
function useLinkedEntry(loaded: boolean): number | null {
  const [seq, setSeq] = useState<number | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const follow = () => {
      const match = /^#ledger-entry-(\d+)$/.exec(window.location.hash);
      const target = match
        ? document.getElementById(window.location.hash.slice(1))
        : null;
      if (!match || !target) return;
      setSeq(Number(match[1]));
      target.scrollIntoView({ block: "center" });
      target.focus({ preventScroll: true });
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [loaded]);
  return seq;
}
