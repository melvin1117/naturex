"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { CommunitiesIndex } from "@/components/communities/communities-index";
import { CommunityPage } from "@/components/communities/community-page";
import { StewardHomeSkeleton } from "@/components/page-skeletons";
import { LoadError } from "@/components/proto/load-error";
import { StewardHome as PrototypeStewardHome } from "@/components/proto/steward-home";
import { useStewardCommunity } from "@/components/shell/steward-community";
import { COMMUNITY_PARAM } from "@/lib/active-community";
import { useCommunitySummary } from "@/lib/community-hooks";
import { useWorld } from "@/lib/hooks";

/**
 * `/steward` (Communities): the communities you're in; `?community=<id>` opens one with its
 * sites. The scripted prototype stands in until the sandbox has a session.
 */
export function StewardHomeRoute() {
  const { world } = useWorld();
  if (!world?.me) return <PrototypeStewardHome />;
  return (
    <Suspense fallback={<StewardHomeSkeleton />}>
      <Communities />
    </Suspense>
  );
}

function Communities() {
  const param = useSearchParams().get(COMMUNITY_PARAM);
  const { active, query } = useStewardCommunity();
  if (param && active?.id === param) return <StewardHome />;
  // One just created: wait for the membership, rather than flash the list.
  if (param && query.isFetching) return <StewardHomeSkeleton />;
  // A community you're not in (or none asked for) shows the list instead.
  return <CommunitiesIndex />;
}

export function StewardHome() {
  const { active } = useStewardCommunity();
  const summary = useCommunitySummary(active?.id);

  if (!active) return null; // StewardGate shows the empty state or the loader.
  if (summary.error && !summary.data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <LoadError
          title="We couldn't load this community"
          error={summary.error}
          retry={summary.refetch}
        />
      </div>
    );
  }
  if (!summary.data || summary.data.community.id !== active.id) {
    return <StewardHomeSkeleton label={`Loading ${active.name}…`} />;
  }
  return <CommunityPage summary={summary.data} onChanged={summary.refetch} />;
}
