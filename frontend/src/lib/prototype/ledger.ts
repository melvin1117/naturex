/**
 * Nature Ledger: append-only, hash-chained per site (dev-spec §17).
 * hash = sha256(canonical_json(payload) + kind + seq + prev_hash).
 */
import { sha256 } from "./sha256";

export type LedgerKind =
  "listing" | "verification" | "report" | "event" | "price_anchor" | "payout";

export type LedgerEntry = {
  seq: number;
  kind: LedgerKind;
  date: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

export const GENESIS = "0".repeat(64);

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function entryHash(
  payload: Record<string, unknown>,
  kind: LedgerKind,
  seq: number,
  prevHash: string,
) {
  return sha256(canonical(payload) + kind + String(seq) + prevHash);
}

export function append(
  chain: LedgerEntry[],
  kind: LedgerKind,
  date: string,
  payload: Record<string, unknown>,
): LedgerEntry[] {
  const seq = chain.length;
  const prevHash = seq === 0 ? GENESIS : chain[seq - 1].hash;
  return [
    ...chain,
    {
      seq,
      kind,
      date,
      payload,
      prevHash,
      hash: entryHash(payload, kind, seq, prevHash),
    },
  ];
}

export type VerifyResult =
  | { valid: true; entries: number }
  | { valid: false; entries: number; brokenAt: number; reason: string };

export function verify(chain: LedgerEntry[]): VerifyResult {
  for (const entry of chain) {
    const expectedPrev = entry.seq === 0 ? GENESIS : chain[entry.seq - 1].hash;
    if (entry.prevHash !== expectedPrev)
      return {
        valid: false,
        entries: chain.length,
        brokenAt: entry.seq,
        reason: "Link to the previous entry doesn't match.",
      };
    const recomputed = entryHash(
      entry.payload,
      entry.kind,
      entry.seq,
      entry.prevHash,
    );
    if (recomputed !== entry.hash)
      return {
        valid: false,
        entries: chain.length,
        brokenAt: entry.seq,
        reason: "Recorded content no longer matches its hash.",
      };
  }
  return { valid: true, entries: chain.length };
}
