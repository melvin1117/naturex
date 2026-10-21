import { ArrowRight, LockKeyhole, Sprout } from "lucide-react";
import Link from "next/link";

import { AccountIdCopy } from "@/components/account-id";
import { Button } from "@/components/ui/button";
import { assetHref } from "@/lib/trade";

/**
 * A Steward asset page (`/steward/assets/[id]/*`) opened by a signed-in account that isn't a
 * member of the community that lists the site. The API refuses its actions anyway (403); this
 * says why and where to go instead of showing the community's controls.
 */
export function NotACommunityMember({
  assetId,
  name,
  meId,
  homeHref,
}: {
  assetId: string;
  name: string;
  meId: string;
  /** The account's own community home; null when it has no community yet. */
  homeHref: string | null;
}) {
  return (
    <section
      aria-labelledby="not-a-member-title"
      className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20"
    >
      <span
        aria-hidden="true"
        className="grid size-12 place-items-center rounded-2xl bg-secondary text-muted-foreground"
      >
        <LockKeyhole className="size-6" />
      </span>
      <h1
        id="not-a-member-title"
        className="mt-6 font-serif text-4xl tracking-tight text-balance sm:text-5xl"
      >
        You&apos;re not a member of the community that lists this site
      </h1>
      <p className="mt-4 max-w-prose text-pretty text-muted-foreground">
        Only the owner and stewards of the community that lists {name} manage it
        here. You can still follow it and back it on the Exchange with play
        money.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        {/* A long site name wraps instead of pushing the page wider than a phone. */}
        <Button
          asChild
          className="h-auto min-h-10 max-w-full shrink py-2 text-left whitespace-normal"
        >
          <Link href={assetHref(assetId)}>
            See {name} on the Exchange
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild variant="outline">
          {homeHref ? (
            <Link href={homeHref}>Your community home</Link>
          ) : (
            <Link href="/steward">
              <Sprout aria-hidden="true" />
              Start a community
            </Link>
          )}
        </Button>
      </div>
      <div className="mt-8 max-w-md rounded-2xl border border-dashed border-border p-4">
        <h2 className="text-sm font-medium">Helping look after this land?</h2>
        <p className="mt-1 mb-3 text-sm text-muted-foreground">
          Give the community&apos;s owner your account ID. Once they&apos;ve
          added you as a steward, reload this page.
        </p>
        <AccountIdCopy id={meId} />
      </div>
    </section>
  );
}
