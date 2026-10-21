/**
 * Focus for screens that swap their content (a wizard step, a page that replaces a form).
 * Only takes focus when it was lost to `<body>` with the content that held it, so it never
 * pulls focus away from where the person is (an error field, the header, another tab).
 */
export function focusIfLost(target: HTMLElement | null): void {
  if (!target) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  target.focus();
}

let communityJustCreated = false;

/** The create-community form replaces itself with the new community's home. */
export function markCommunityCreated(): void {
  communityJustCreated = true;
}

/** True once after `markCommunityCreated`, so only that home takes focus. */
export function takeCommunityCreated(): boolean {
  const created = communityJustCreated;
  communityJustCreated = false;
  return created;
}
