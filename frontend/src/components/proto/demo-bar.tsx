"use client";

import { useEffect } from "react";

import { useSignOut, useWorld } from "@/lib/hooks";
import { useInSandbox } from "@/lib/nav";
import { usePrototype } from "@/lib/prototype/store";

/**
 * Outside the sandbox (the welcome and the story) nobody acts as anyone; inside it the
 * sandbox's own header (components/shell/sandbox-header.tsx) shows who you are. A browser may
 * still hold a demo persona in the real app's cookie from before the sandbox had its own
 * address, or the scripted prototype demo: end both.
 */
export function DemoBar() {
  const sandbox = useInSandbox();
  return sandbox ? null : <LeftoverDemoCleanup />;
}

function LeftoverDemoCleanup() {
  const { world } = useWorld();
  const { demo, exitDemo } = usePrototype();
  const signOut = useSignOut();
  const leftover = Boolean(world?.me?.persona);
  useEffect(() => {
    if (demo) exitDemo();
  }, [demo, exitDemo]);
  const { mutate } = signOut;
  useEffect(() => {
    if (leftover) void mutate();
  }, [leftover, mutate]);
  return null;
}
