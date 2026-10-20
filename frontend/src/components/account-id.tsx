"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

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

/**
 * The signed-in account's ID with a Copy button. Stewards are added by account ID (never
 * email, T68), so whoever wants to join a community gives its owner this.
 */
export function AccountIdCopy({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div>
      <div className="flex items-center gap-2">
        <code
          translate="no"
          className="min-w-0 flex-1 truncate rounded-lg bg-secondary px-2 py-1.5 font-mono text-xs select-all"
        >
          {id}
        </code>
        <Button
          variant="outline"
          size="sm"
          aria-label="Copy account ID"
          onClick={() =>
            void copyText(id).then((ok) => setState(ok ? "copied" : "failed"))
          }
        >
          {state === "copied" ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          Copy
        </Button>
      </div>
      <p
        aria-live="polite"
        className="mt-1.5 min-h-4 text-xs text-muted-foreground"
      >
        {state === "copied"
          ? "Account ID copied."
          : state === "failed"
            ? "Couldn't copy. Select the ID and copy it yourself."
            : ""}
      </p>
    </div>
  );
}
