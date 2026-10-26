"use client";

/**
 * Navigation that works in both the real app and the sandbox (`/sandbox/*`). Screens use these
 * instead of `next/navigation`'s: `usePathname` returns the app path (no `/sandbox`), and
 * `useRouter` adds the prefix back inside the sandbox, so a screen never needs to know where
 * it runs.
 */

import {
  usePathname as useNextPathname,
  useRouter as useNextRouter,
} from "next/navigation";
import { useCallback, useMemo } from "react";

import { appPath, isSandboxPath, sandboxHref } from "@/lib/sandbox";

/** Whether this page is in the visitor's sandbox. */
export function useInSandbox(): boolean {
  return isSandboxPath(useNextPathname());
}

/** The app path, without `/sandbox`. */
export function usePathname(): string {
  const pathname = useNextPathname();
  // Outside the app router (some tests) Next returns null despite its type; pass it through.
  return pathname == null ? pathname : appPath(pathname);
}

const sameHref = (href: string) => href;

/** An app href as this page should link to it (prefixed inside the sandbox). */
export function useHref(): (href: string) => string {
  const sandbox = useInSandbox();
  return sandbox ? sandboxHref : sameHref;
}

/**
 * Rewrite the address to an app href without a navigation (filters, tabs: Next keeps
 * `useSearchParams` in step). Inside the sandbox it keeps the `/sandbox` prefix: a bare app
 * path would take the page out of the sandbox and its session.
 */
export function useReplaceUrl(): (href: string) => void {
  const resolve = useHref();
  return useCallback(
    (href: string) => window.history.replaceState(null, "", resolve(href)),
    [resolve],
  );
}

type Router = ReturnType<typeof useNextRouter>;

/** `next/navigation`'s router, adding `/sandbox` to app paths inside the sandbox. */
export function useRouter(): Router {
  const router = useNextRouter();
  const sandbox = useInSandbox();
  return useMemo(() => {
    if (!sandbox) return router;
    return {
      ...router,
      push: (href, options) => router.push(sandboxHref(href), options),
      replace: (href, options) => router.replace(sandboxHref(href), options),
      prefetch: (href, options) => router.prefetch(sandboxHref(href), options),
    } satisfies Router;
  }, [router, sandbox]);
}
