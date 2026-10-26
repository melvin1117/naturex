"use client";

import { useEffect } from "react";

import { useSignOut, useWorld } from "@/lib/hooks";
import { useInSandbox } from "@/lib/nav";

/**
 * Outside the sandbox (the welcome and the story) nobody acts as anyone; inside it the
 * sandbox's own header (components/shell/sandbox-header.tsx) shows who you are. A browser may
 * still hold a demo persona in the real app's cookie from before the sandbox had its own
 * address: end it. It also drops what the old scripted prototype kept in the browser.
 */
export function LeftoverDemo() {
  const sandbox = useInSandbox();
  useEffect(() => {
    try {
      window.localStorage.removeItem("ww-prototype-world");
      window.localStorage.removeItem("ww-prototype-tour");
      window.sessionStorage.removeItem("ww-prototype-demo");
    } catch {
      // Storage can be unavailable (privacy modes); nothing to clean then.
    }
  }, []);
  return sandbox ? null : <LeftoverDemoCleanup />;
}

function LeftoverDemoCleanup() {
  const { world } = useWorld();
  const signOut = useSignOut();
  const leftover = Boolean(world?.me?.persona);
  const { mutate } = signOut;
  useEffect(() => {
    if (leftover) void mutate();
  }, [leftover, mutate]);
  return null;
}
