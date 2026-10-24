"use client";

import { ArrowUp, Sparkles } from "lucide-react";
import Link from "@/components/app-link";
import { usePathname } from "@/lib/nav";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { AccountCopilot } from "@/components/account-copilot";
import { LiveBadge } from "@/components/proto/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useReturnFocus } from "@/lib/use-return-focus";
import { SUGGESTED_QUESTIONS } from "@/lib/prototype/copilot";
import { useTour } from "@/components/proto/tour";
import { useWorld } from "@/lib/hooks";
import { usePrototype } from "@/lib/prototype/store";
import { traceAssetFromPath } from "@/lib/run-trace";

function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
        part.startsWith("**") ? (
          <strong key={i} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * The header's Copilot sheet. A signed-in account gets the real Copilot (#213): world-wide,
 * or about the site whose page is open. Anonymous visitors and the guided tour keep the
 * prototype's scripted answers.
 */
export function CopilotSheet() {
  const { ui, closeCopilot } = usePrototype();
  const tour = useTour();
  const pathname = usePathname();
  const { world: apiWorld } = useWorld();
  const real = Boolean(apiWorld?.me) && !tour.active;
  const returnFocus = useReturnFocus(ui.copilotOpen);

  return (
    <Sheet
      modal={!tour.active}
      open={ui.copilotOpen}
      onOpenChange={(open) => !open && closeCopilot()}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-md"
        data-tour="copilot-sheet"
        onCloseAutoFocus={returnFocus}
        onInteractOutside={(e) => {
          if ((e.target as HTMLElement | null)?.closest("[data-tour-card]"))
            e.preventDefault();
        }}
      >
        {/* The sheet mounts its content only while open. */}
        {real ? (
          <AccountCopilot
            pageAssetId={traceAssetFromPath(pathname)}
            onNavigate={closeCopilot}
          />
        ) : (
          <ScriptedCopilot />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The prototype's scripted Copilot: a site to ask about and recorded answers. */
function ScriptedCopilot() {
  const { world, ui, closeCopilot, ask, openCopilot } = usePrototype();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const rated = world.sites.filter((s) => s.reports.length);
  const siteId =
    ui.copilotSiteId ??
    rated.find((s) => s.id === "xochimilco-wetland")?.id ??
    rated[0]?.id ??
    null;
  const site = world.sites.find((s) => s.id === siteId);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
        ? "auto"
        : "smooth",
    });
  }, [world.copilot.length, ui.copilotTyping]);

  function submit(q: string) {
    if (!q.trim()) return;
    ask(q, siteId);
    setDraft("");
  }

  return (
    <>
      <SheetHeader className="border-b px-6 pt-6 pb-4">
        <div className="flex items-center gap-2">
          <SheetTitle className="font-serif text-3xl font-normal">
            Copilot
          </SheetTitle>
          <LiveBadge />
        </div>
        <SheetDescription>
          Answers come from the site&apos;s reports, news and ledger, with
          sources. Nemotron 3 Nano in the full build; scripted answers in this
          prototype.
        </SheetDescription>
        {rated.length > 0 && (
          <Select
            value={siteId ?? undefined}
            onValueChange={(v) => openCopilot(v)}
          >
            <SelectTrigger
              className="mt-2 w-full"
              aria-label="Site to ask about"
            >
              <SelectValue placeholder="Choose a site" />
            </SelectTrigger>
            <SelectContent>
              {rated.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SheetHeader>
      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5"
        aria-live="polite"
      >
        {world.copilot.length === 0 && (
          <div className="rounded-3xl bg-secondary p-5">
            <Sparkles className="size-5 text-lime-ink" aria-hidden="true" />
            <p className="mt-2 text-sm">
              Ask about {site ? site.name : "a site"}: why its grade or price
              changed, how the value is estimated, or how sure the rating is.
            </p>
          </div>
        )}
        {world.copilot.map((m) => (
          <div
            key={m.id}
            className={cn(
              "flex",
              m.role === "user" ? "justify-end" : "justify-start",
            )}
          >
            <div
              className={cn(
                "nx-rise max-w-[88%] rounded-3xl px-4 py-3 text-sm leading-relaxed",
                m.role === "user"
                  ? "rounded-br-lg bg-primary text-primary-foreground"
                  : "rounded-bl-lg bg-card shadow-soft",
              )}
            >
              <Rich text={m.text} />
              {m.citations.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {m.citations.map((c) => (
                    <Link
                      key={c.label + c.href}
                      href={c.href}
                      onClick={closeCopilot}
                      className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-accent"
                    >
                      {c.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {ui.copilotTyping && (
          <div className="flex">
            <div
              className="rounded-3xl rounded-bl-lg bg-card px-4 py-3 shadow-soft"
              aria-label="Copilot is writing"
            >
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="size-1.5 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="border-t px-6 pt-3 pb-6">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {SUGGESTED_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => submit(q)}
              className="rounded-full border border-input bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent"
            >
              {q}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
          className="flex gap-2"
        >
          <label htmlFor="copilot-input" className="sr-only">
            Ask the Copilot
          </label>
          <Input
            id="copilot-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Why did it drop?"
            className="rounded-full"
            data-tour="copilot-input"
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send question"
            disabled={!draft.trim()}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </form>
      </div>
    </>
  );
}
