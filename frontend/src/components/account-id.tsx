"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/** How long a copy control says "Copied" before it reads "Copy" again. */
export const COPIED_MS = 2_000;

/** Copy to the clipboard; false when the browser refuses (no permission, insecure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export type CopyState = "idle" | "copied" | "failed";

/**
 * Copy `text` and say so on the control itself: "copied" for `COPIED_MS`, then back to idle;
 * "failed" stays until the next try, so its instructions can be read.
 */
export function useCopy(text: string): {
  state: CopyState;
  copy: () => Promise<void>;
} {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async () => {
    const ok = await copyText(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setState(ok ? "copied" : "failed");
    if (ok) timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  }, [text]);
  return { state, copy };
}

/** The copy icon, a check while "copied"; the swap only animates without reduced motion. */
export function CopyIcon({ copied }: { copied: boolean }) {
  return copied ? (
    <Check
      aria-hidden="true"
      className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-50"
    />
  ) : (
    <Copy aria-hidden="true" />
  );
}

/**
 * The signed-in account's ID with a Copy button. Stewards are added by account ID (never
 * email, T68), so whoever wants to join a community gives its owner this.
 */
export function AccountIdCopy({ id }: { id: string }) {
  const { state, copy } = useCopy(id);
  const copied = state === "copied";
  return (
    <div>
      {/* Wraps rather than truncates: the whole ID must stay readable, even at 390 px. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <code
          translate="no"
          className="rounded-lg bg-secondary px-2 py-1.5 font-mono text-xs break-all select-all"
        >
          {id}
        </code>
        <Button
          variant="outline"
          size="sm"
          className="min-w-24"
          data-state={state}
          aria-label={copied ? "Copied" : "Copy account ID"}
          onClick={() => void copy()}
        >
          <CopyIcon copied={copied} />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p
        aria-live="polite"
        className="mt-1.5 min-h-4 text-xs text-muted-foreground"
      >
        {copied && <span className="sr-only">Account ID copied.</span>}
        {state === "failed" &&
          "Couldn't copy. Select the ID and copy it yourself."}
      </p>
    </div>
  );
}
