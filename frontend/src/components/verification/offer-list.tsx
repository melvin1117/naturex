"use client";

import { ArrowRight, Check, Undo2 } from "lucide-react";
import Link from "@/components/app-link";
import { useState } from "react";
import { toast } from "sonner";

import { QueueRowsSkeleton } from "@/components/page-skeletons";
import { LoadError } from "@/components/proto/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PendingOffer } from "@/lib/api/types";
import { trimDecimal } from "@/lib/ipo";
import {
  useApproveOffer,
  usePendingOffers,
  useSendBackOffer,
} from "@/lib/offer-hooks";
import { date, int } from "@/lib/prototype/format";
import { assetHref, unitPriceText } from "@/lib/trade";

/** The opening offers waiting for the Reviewer, oldest first (ADR-0008 §5). */
export function OfferList() {
  const offers = usePendingOffers();
  if (offers.error && !offers.data)
    return (
      <LoadError
        title="We couldn't load the offers"
        error={offers.error}
        retry={offers.refetch}
      />
    );
  if (!offers.data) return <QueueRowsSkeleton label="Loading the offers…" />;
  if (offers.data.length === 0)
    return (
      <p className="rounded-3xl bg-card p-8 text-center text-muted-foreground shadow-soft">
        No offer is waiting. When a community sends one, it shows here.
      </p>
    );
  return (
    <ul aria-label="Offers waiting for review" className="space-y-4">
      {offers.data.map((offer) => (
        <OfferRow key={offer.asset_id} offer={offer} />
      ))}
    </ul>
  );
}

const DOCUMENTS: Record<string, string> = {
  verified: "Documents verified",
  documents_submitted: "Documents to read",
  rejected: "Documents rejected",
  revoked: "Verification revoked",
};

function OfferRow({ offer }: { offer: PendingOffer }) {
  const approve = useApproveOffer(offer.asset_id);
  const [sendingBack, setSendingBack] = useState(false);
  const level = offer.verification.level;
  return (
    <li className="rounded-3xl bg-card p-5 shadow-soft sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className="font-serif text-2xl leading-tight break-words">
            {offer.asset_name}
          </h2>
          <p className="text-sm text-muted-foreground">
            {[offer.community_name, `sent ${date(offer.sent_at)}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {offer.grade && <Badge variant="secondary">{offer.grade}</Badge>}
            <Badge variant="outline">
              {DOCUMENTS[level] ?? "No documents (optional here)"}
            </Badge>
          </div>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href={assetHref(offer.asset_id)}>
            See the site
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
      <dl className="tabular mt-5 grid gap-4 rounded-2xl bg-secondary p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Price a unit</dt>
          <dd className="text-xl font-light">
            {unitPriceText(offer.ipo_price)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Units on offer</dt>
          <dd className="text-xl font-light">{int(offer.shares_offered)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Community keeps</dt>
          <dd className="text-xl font-light">
            {trimDecimal(offer.retained_pct)}%
          </dd>
        </div>
      </dl>
      {approve.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {approve.error.message}
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button
          disabled={approve.isPending}
          onClick={async () => {
            const done = await approve.mutate();
            if (done)
              toast(`${offer.asset_name} is on the Marketplace`, {
                description: "Supporters can back it from now on.",
              });
          }}
        >
          <Check aria-hidden="true" />
          {approve.isPending ? "Approving…" : "Approve and list"}
        </Button>
        <Button
          variant="outline"
          disabled={approve.isPending}
          onClick={() => setSendingBack(true)}
        >
          <Undo2 aria-hidden="true" />
          Send back
        </Button>
      </div>
      <SendBackDialog
        offer={offer}
        open={sendingBack}
        onOpenChange={setSendingBack}
      />
    </li>
  );
}

function SendBackDialog({
  offer,
  open,
  onOpenChange,
}: {
  offer: PendingOffer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sendBack = useSendBackOffer(offer.asset_id);
  const [note, setNote] = useState("");
  const trimmed = note.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-3xl">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!trimmed) return;
            if (await sendBack.mutate(trimmed)) {
              onOpenChange(false);
              setNote("");
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Send {offer.asset_name}&apos;s offer back?
            </DialogTitle>
            <DialogDescription>
              The community sees your note and can change the offer before
              sending it again.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            <Label htmlFor={`note-${offer.asset_id}`}>
              What should they change?
            </Label>
            <Textarea
              id={`note-${offer.asset_id}`}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              required
            />
          </div>
          {sendBack.error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {sendBack.error.message}
            </p>
          )}
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Keep it waiting
            </Button>
            <Button type="submit" disabled={!trimmed || sendBack.isPending}>
              {sendBack.isPending ? "Sending…" : "Send back"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
