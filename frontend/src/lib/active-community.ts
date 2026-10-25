/**
 * The community the Steward app shows (T62), remembered per account in this browser. Only the
 * community ID is stored, never account data, and it's always checked against
 * `GET /me/communities` before use. The `?community=` URL parameter wins over it.
 */

export const COMMUNITY_PARAM = "community";

const PREFIX = "ww-steward-community:";
const listeners = new Set<() => void>();

export function rememberedCommunityKey(meId: string): string {
  return `${PREFIX}${meId}`;
}

export function readRememberedCommunity(meId: string): string | null {
  try {
    return window.localStorage.getItem(rememberedCommunityKey(meId));
  } catch {
    return null;
  }
}

function write(change: () => void) {
  try {
    change();
  } catch {
    // Storage blocked: the URL still carries the choice.
  }
  listeners.forEach((listener) => listener());
}

export function rememberCommunity(meId: string, communityId: string) {
  write(() =>
    window.localStorage.setItem(rememberedCommunityKey(meId), communityId),
  );
}

/** On sign-out: the next person on this browser shouldn't inherit the choice. */
export function forgetCommunity(meId: string) {
  write(() => window.localStorage.removeItem(rememberedCommunityKey(meId)));
}

/** For `useSyncExternalStore`: changes in this tab and in other tabs. */
export function subscribeRememberedCommunity(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
