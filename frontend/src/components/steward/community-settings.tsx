"use client";

import { ArrowLeft, Check, Copy } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { LoadError } from "@/components/proto/load-error";
import { Panel } from "@/components/proto/report-panels";
import { useStewardCommunity } from "@/components/shell/steward-community";
import { EditCommunityForm } from "@/components/steward/community-form";
import { MembersPanel } from "@/components/steward/members-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useCommunitySummary, useMeId } from "@/lib/community-hooks";
import { countryName } from "@/lib/market-cards";
import { COMMUNITY_ROLE_LABEL } from "@/lib/navigation";

/**
 * `/steward/community`: the community's details and members (T63, story A0). The owner edits
 * the profile and adds or removes stewards; stewards see them. The API authorizes each change.
 */
export function CommunitySettings() {
  const meId = useMeId();
  const { active, href } = useStewardCommunity();
  // The profile from the summary, so a saved edit shows everywhere it's used.
  const summary = useCommunitySummary(active?.id);
  const [saved, setSaved] = useState(false);

  if (!meId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <Alert>
          <AlertTitle>Sign in to manage a community</AlertTitle>
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

  const community = summary.data?.community;
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
        <Panel
          title={isOwner ? "Edit community" : "About the community"}
          aria-label="Community details"
        >
          {summary.error && !community ? (
            <LoadError
              title="We couldn't load the community"
              error={summary.error}
              retry={summary.refetch}
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
            <dl className="space-y-3 text-sm">
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
              <p className="text-xs text-muted-foreground">
                Only the owner can change these details.
              </p>
            </dl>
          )}
        </Panel>
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
  const [copied, setCopied] = useState(false);
  return (
    <Panel title="Your account ID" aria-label="Your account ID">
      <p className="text-sm text-muted-foreground">
        To be added to another community, give its owner this ID.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-secondary px-2 py-1.5 font-mono text-xs">
          {id}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(id).then(() => setCopied(true));
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </Panel>
  );
}
