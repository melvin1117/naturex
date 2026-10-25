"use client";

/**
 * The unseen-updates dot on the Steward app's "Community home". What the home shows that can
 * change while the steward is elsewhere (a reviewer's decision, a listing's next step, a new
 * alert) is reduced to one signature; viewing the home remembers it per account and community
 * in this browser, and the nav shows the dot while the current signature differs. Only a hash
 * is stored, never account data. Without a remembered signature there's nothing to compare
 * with, so no dot.
 */
import { useEffect, useSyncExternalStore } from "react";

import type { AlertList, CommunitySummary } from "./api/types";
import { useCommunitySummary } from "./community-hooks";
import { useAlerts, useWorld } from "./hooks";

const PREFIX = "ww-community-home-seen:";
const listeners = new Set<() => void>();

export function homeSeenKey(meId: string, communityId: string): string {
  return `${PREFIX}${meId}:${communityId}`;
}

/** FNV-1a, 32-bit: a short, stable stand-in for the signature. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * What the community home shows that can change on its own: each listing's next step and
 * latest verification decision, and the newest alert about the community's sites.
 */
export function homeSignature(
  summary: Pick<CommunitySummary, "listings">,
  alerts: Pick<AlertList, "alerts"> | null,
): string {
  const listings = summary.listings
    .map((l) =>
      [
        l.asset.id,
        l.next_action,
        l.verification.decision ?? "",
        l.verification.decided_at ?? "",
      ].join(":"),
    )
    .sort();
  return hash([...listings, `alert:${alerts?.alerts[0]?.id ?? ""}`].join("|"));
}

/** Something changed since the home was last viewed (and it has been viewed before). */
export function hasUnseenUpdates(
  signature: string | null,
  seen: string | null,
): boolean {
  return signature !== null && seen !== null && signature !== seen;
}

export function readHomeSeen(meId: string, communityId: string): string | null {
  try {
    return window.localStorage.getItem(homeSeenKey(meId, communityId));
  } catch {
    return null;
  }
}

export function rememberHomeSeen(
  meId: string,
  communityId: string,
  signature: string,
) {
  try {
    window.localStorage.setItem(homeSeenKey(meId, communityId), signature);
  } catch {
    // Storage blocked: the dot just can't be cleared for long.
  }
  listeners.forEach((listener) => listener());
}

/** For `useSyncExternalStore`: changes in this tab and in other tabs. */
export function subscribeHomeSeen(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/**
 * Whether the community home has updates the signed-in member hasn't seen. While `viewing`
 * (the home is on screen), it remembers what's shown instead, so the dot clears there.
 */
export function useCommunityHomeUpdates(
  communityId: string | undefined,
  viewing: boolean,
): boolean {
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  const id = meId ? communityId : undefined;
  // On the home, the page's own summary listens to live events; elsewhere this one does.
  const summary = useCommunitySummary(id, { live: viewing ? "off" : "status" });
  const alerts = useAlerts({ communityId: id });
  const seen = useSyncExternalStore(
    subscribeHomeSeen,
    () => (meId && id ? readHomeSeen(meId, id) : null),
    () => null,
  );

  const data = id && summary.data?.community.id === id ? summary.data : null;
  const alertsSettled =
    alerts.status === "success" || alerts.status === "error";
  const signature =
    data && alertsSettled ? homeSignature(data, alerts.data ?? null) : null;

  useEffect(() => {
    if (!viewing || !meId || !id || signature === null) return;
    if (signature !== seen) rememberHomeSeen(meId, id, signature);
  }, [viewing, meId, id, signature, seen]);

  return !viewing && hasUnseenUpdates(signature, seen);
}
