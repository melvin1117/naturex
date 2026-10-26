"use client";

import { useEffect } from "react";

import { useSignOut, useWorld } from "@/lib/hooks";
import { useInSandbox } from "@/lib/nav";

/**
 * Outside the sandbox (the welcome and the story) nobody acts as anyone; inside it the
 * sandbox's own header (components/shell/sandbox-header.tsx) shows who you are. A browser may
 * still hold a demo persona in the real app's cookie from before the sandbox had its own
 * address: end it.
 */
export function LeftoverDemo() {
  const sandbox = useInSandbox();
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
