"use client";

import { ArrowRight, ScrollText } from "lucide-react";
import Link from "@/components/app-link";

import { LoadError } from "@/components/proto/load-error";
import { Spinner } from "@/components/ui/spinner";
import { Checklist, VerificationBadge } from "@/components/verification/parts";
import type { VerificationPublic } from "@/lib/api/types";
import { useWorld } from "@/lib/hooks";
import { date } from "@/lib/prototype/format";
import {
  adminReviewHref,
  LEVEL_LABEL,
  ledgerEntryHref,
  reviewerLabel,
} from "@/lib/verification";
import { useVerificationPanel } from "@/lib/verification-hooks";

export const VERIFICATION_PANEL_ID = "verification";

/**
 * On the asset's own page, follow a ledger link without a router navigation: push the URL (the
 * router picks up `?tab=ledger`) and announce the new hash, so an already open ledger scrolls
 * to the entry too. Modified clicks (new tab, new window) keep the browser's behaviour.
 */
function followLedgerLink(event: React.MouseEvent<HTMLAnchorElement>) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const url = new URL(event.currentTarget.href, window.location.href);
  if (url.pathname !== window.location.pathname) return;
  event.preventDefault();
  window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/**
 * "How this listing was verified" (ADR-0006 §4), on every Exchange asset page: the API's
 * badge, level, date, reviewer role, each check's result, everything not checked and the
 * ledger entry. Public, so it never shows documents, values or reasons.
 */
export function VerificationPanel({ assetId }: { assetId: string }) {
  const panel = useVerificationPanel(assetId);
  return (
    <section
      id={VERIFICATION_PANEL_ID}
      aria-labelledby="verification-heading"
      tabIndex={-1}
      className="scroll-mt-24 rounded-3xl bg-card p-6 shadow-soft outline-none sm:p-8"
    >
      <h2 id="verification-heading" className="font-serif text-3xl">
        How this listing was verified
      </h2>
      <div className="mt-4">
        {panel.data ? (
          <PanelBody data={panel.data} />
        ) : panel.error ? (
          <LoadError
            title="We couldn't load how this listing was verified"
            error={panel.error}
            retry={panel.refetch}
          />
        ) : (
          <p
            role="status"
            className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
          >
            <Spinner aria-hidden="true" role="presentation" />
            Loading the verification record…
          </p>
        )}
      </div>
    </section>
  );
}

function decisionDate(data: VerificationPublic): {
  label: string;
  value: string;
} | null {
  if (data.level === "revoked" && data.revoked_at)
    return { label: "Revoked on", value: date(data.revoked_at) };
  if (data.decided_at)
    return { label: "Decided on", value: date(data.decided_at) };
  if (data.submitted_at)
    return { label: "Submitted on", value: date(data.submitted_at) };
  return null;
}

const LEVEL_EXPLAINER: Record<VerificationPublic["level"], string> = {
  unverified:
    "No reviewed documents back this listing yet: only the community's own attestation.",
  documents_submitted:
    "The community submitted documents and the automated checks ran. A reviewer hasn't decided yet.",
  verified:
    "A reviewer read the automated checks and the documents, then approved the listing.",
  rejected:
    "A reviewer found a problem with the submitted documents. The community can submit again.",
  revoked:
    "An approved verification was withdrawn, so trading is paused until a new review approves it.",
};

function PanelBody({ data }: { data: VerificationPublic }) {
  const { world } = useWorld();
  const when = decisionDate(data);
  const reviewer = reviewerLabel(data.reviewer_role);
  return (
    <div className="space-y-6">
      <div>
        <VerificationBadge level={data.level} className="text-sm">
          {data.badge}
        </VerificationBadge>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          {LEVEL_EXPLAINER[data.level]}
        </p>
      </div>

      <dl className="grid gap-4 rounded-2xl bg-secondary/50 p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Level</dt>
          <dd className="mt-0.5 font-medium">{LEVEL_LABEL[data.level]}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{when?.label ?? "Date"}</dt>
          <dd className="tabular mt-0.5 font-medium">
            {when?.value ?? "Not yet"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Reviewed by</dt>
          <dd className="mt-0.5 font-medium">
            {reviewer ?? "No reviewer yet"}
          </dd>
        </div>
      </dl>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="font-semibold">What was checked</h3>
          <div className="mt-3">
            {data.checks && data.checks.length > 0 ? (
              <Checklist items={data.checks} label="Checks and their results" />
            ) : (
              <p className="text-sm text-muted-foreground">
                No checks have run: no documents were submitted for the listing
                as it is now.
              </p>
            )}
          </div>
          {data.method_version && (
            <p
              translate="no"
              className="mt-3 font-mono text-[11px] text-muted-foreground"
            >
              Method {data.method_version}
            </p>
          )}
        </div>
        <div>
          <h3 className="font-semibold">Not checked</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            No part of this process confirms any of these.
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm">
            {data.not_checked.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {data.ledger_seq != null ? (
          <Link
            href={ledgerEntryHref(data.asset_id, data.ledger_seq)}
            onClick={followLedgerLink}
            className="inline-flex items-center gap-1.5 font-medium underline underline-offset-4"
          >
            <ScrollText className="size-4" aria-hidden="true" />
            See the decision in the Record (entry #{data.ledger_seq})
          </Link>
        ) : (
          <p className="text-muted-foreground">
            No verification decision is in the Record yet.
          </p>
        )}
        {world?.me?.is_admin && (
          <Link
            href={adminReviewHref(data.asset_id)}
            className="inline-flex items-center gap-1.5 font-medium underline underline-offset-4"
          >
            Review in the control room
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        )}
      </div>
    </div>
  );
}

/** The page's badge, linking to the panel; nothing until the record loads. */
export function VerificationHeroBadge({ assetId }: { assetId: string }) {
  const panel = useVerificationPanel(assetId);
  if (!panel.data) return null;
  return (
    <a
      href={`#${VERIFICATION_PANEL_ID}`}
      className="max-w-full rounded-full focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
    >
      <VerificationBadge level={panel.data.level} tone="image">
        {panel.data.badge}
      </VerificationBadge>
      <span className="sr-only">: how this listing was verified</span>
    </a>
  );
}
