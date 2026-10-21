"use client";

import { ArrowLeft, Check } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AccountIdCopy } from "@/components/account-id";
import { LoadError } from "@/components/proto/load-error";
import { StewardPanel } from "@/components/steward/panel";
import { useStewardCommunity } from "@/components/shell/steward-community";
import { EditCommunityForm } from "@/components/steward/community-form";
import { MembersPanel } from "@/components/steward/members-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useCommunity, useMeId } from "@/lib/community-hooks";
import { countryName } from "@/lib/market-cards";
import { COMMUNITY_ROLE_LABEL } from "@/lib/navigation";

/**
 * `/steward/community`: the community's details and members (T63, story A0). The owner edits
 * the profile and adds or removes stewards; stewards see them. The API authorizes each change.
 */
export function CommunitySettings() {
  const meId = useMeId();
  const { active, href } = useStewardCommunity();
  const profile = useCommunity(active?.id);
  const [saved, setSaved] = useState(false);

  if (!meId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <Alert>
          <AlertTitle className="line-clamp-none">
            Sign in to manage a community
          </AlertTitle>
          <AlertDescription>
            <p>The scripted demo has no community settings.</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/login?next=%2Fsteward%2Fcommunity">Sign in</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!active) return null;

  const community = profile.data;
  const isOwner = active.role === "owner";

  return (
    <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href={href("/steward")}>
          <ArrowLeft aria-hidden="true" />
          Community home
        </Link>
      </Button>
      <h1 className="mt-2 font-serif text-5xl leading-none tracking-tight text-balance break-words">
        {community?.name ?? active.name}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        You&apos;re its {COMMUNITY_ROLE_LABEL[active.role].toLowerCase()}.
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <StewardPanel
          title={isOwner ? "Edit community" : "About the community"}
        >
          {profile.error && !community ? (
            <LoadError
              title="We couldn't load the community"
              error={profile.error}
              retry={profile.refetch}
            />
          ) : !community ? (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Spinner aria-hidden="true" role="presentation" />
              Loading…
            </p>
          ) : isOwner ? (
            <>
              <EditCommunityForm
                community={community}
                onSaved={() => setSaved(true)}
                onEdit={() => setSaved(false)}
              />
              <p
                aria-live="polite"
                className="mt-3 flex items-center gap-1.5 text-sm text-lime-ink"
              >
                {saved && (
                  <>
                    <Check className="size-4" aria-hidden="true" />
                    Saved.
                  </>
                )}
              </p>
            </>
          ) : (
            <div className="space-y-3 text-sm">
              <dl className="space-y-3">
                <div>
                  <dt className="text-muted-foreground">Country</dt>
                  <dd>{countryName(community.country ?? null) ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">About</dt>
                  <dd className="whitespace-pre-line">
                    {community.description ?? "—"}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                Only the owner can change these details.
              </p>
            </div>
          )}
        </StewardPanel>
        <div className="space-y-6">
          <MembersPanel communityId={active.id} manage={isOwner} />
          <YourAccountId id={meId} />
        </div>
      </div>
    </div>
  );
}

/** Stewards are added by account ID (never email), so each account can share its own. */
function YourAccountId({ id }: { id: string }) {
  return (
    <StewardPanel title="Your account ID">
      <p className="mb-3 text-sm text-muted-foreground">
        To be added to another community, give its owner this ID.
      </p>
      <AccountIdCopy id={id} />
    </StewardPanel>
  );
}
