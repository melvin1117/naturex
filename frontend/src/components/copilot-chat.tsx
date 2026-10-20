"use client";

import { ArrowUp, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { isAbortError, toApiError } from "@/lib/api/errors";
import type { CopilotSource } from "@/lib/api/types";
import { loginHref } from "@/lib/auth";
import {
  answerParts,
  askCopilot,
  sourceHref,
  sourceLabel,
} from "@/lib/copilot";
import { useDataLayer } from "@/lib/data-layer";
import { useWorld } from "@/lib/hooks";

export const COPILOT_SUGGESTIONS = [
  "Why did the price change?",
  "What drives this grade?",
  "How is the value estimated?",
];

const MAX_QUESTION = 500;

type Status = "searching" | "writing" | "done" | "error";

interface Turn {
  id: number;
  question: string;
  answer: string;
  status: Status;
  sourcesFound: number;
  citations: CopilotSource[];
  mode: "model" | "extractive" | "refusal" | null;
  error: string | null;
}

/**
 * The Investor Copilot for one asset (T39): streamed answers grounded in the site's reports and
 * news, with every `[ref]` linking to its source. Signed-out visitors are asked to sign in.
 */
export function CopilotChat({
  assetId,
  assetName,
}: {
  assetId: string;
  assetName: string;
}) {
  const { api } = useDataLayer();
  const { world } = useWorld();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const pending = turns.some(
    (t) => t.status === "searching" || t.status === "writing",
  );

  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => abort.current?.abort(), []);

  // Follow the conversation: a streamed answer and its source links end at the bottom.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [turns]);

  if (!world?.me) {
    return (
      <Shell>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link href={loginHref(search ? `${pathname}?${search}` : pathname)}>
            Sign in to ask the Copilot
          </Link>
        </Button>
      </Shell>
    );
  }

  function update(id: number, patch: (turn: Turn) => Partial<Turn>) {
    setTurns((all) =>
      all.map((t) => (t.id === id ? { ...t, ...patch(t) } : t)),
    );
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || pending) return;
    const id = nextId.current++;
    setDraft("");
    setTurns((all) => [
      ...all,
      {
        id,
        question: q,
        answer: "",
        status: "searching",
        sourcesFound: 0,
        citations: [],
        mode: null,
        error: null,
      },
    ]);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await askCopilot(
        api,
        { question: q, asset_id: assetId },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "sources")
              update(id, () => ({
                status: "writing",
                sourcesFound: event.sources.length,
              }));
            else if (event.type === "delta")
              update(id, (t) => ({ answer: t.answer + event.text }));
            else if (event.type === "done")
              update(id, () => ({
                status: "done",
                answer: event.answer,
                citations: event.citations,
                mode: event.mode,
              }));
            else
              update(id, () => ({
                status: "error",
                error: "The Copilot couldn't finish this answer. Try again.",
              }));
          },
        },
      );
      update(id, (t) =>
        t.status === "done" || t.status === "error"
          ? {}
          : {
              status: "error",
              error: "The answer was cut off. Try again.",
            },
      );
    } catch (error) {
      if (isAbortError(error)) return;
      update(id, () => ({
        status: "error",
        error: toApiError(error).message,
      }));
    }
  }

  return (
    <Shell>
      <div
        ref={listRef}
        data-testid="copilot-turns"
        className="mt-4 max-h-[28rem] space-y-4 overflow-y-auto"
        aria-live="polite"
        aria-busy={pending}
      >
        {turns.length === 0 && (
          <p className="flex gap-2 rounded-2xl bg-secondary p-4 text-sm">
            <Sparkles
              className="mt-0.5 size-4 shrink-0 text-lime-ink"
              aria-hidden="true"
            />
            Ask about {assetName}: why its grade or price changed, how the value
            is estimated, or what the news says.
          </p>
        )}
        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {COPILOT_SUGGESTIONS.map((q) => (
          <Button
            key={q}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto rounded-full px-3 py-1.5 text-xs"
            disabled={pending}
            onClick={() => void ask(q)}
          >
            {q}
          </Button>
        ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
      >
        <label htmlFor={`copilot-${assetId}`} className="sr-only">
          Ask the Copilot about {assetName}
        </label>
        <Input
          id={`copilot-${assetId}`}
          value={draft}
          maxLength={MAX_QUESTION}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Why did it drop?"
          className="rounded-full"
          autoComplete="off"
        />
        <Button
          type="submit"
          size="icon"
          aria-label="Send question"
          disabled={!draft.trim() || pending}
        >
          <ArrowUp aria-hidden="true" />
        </Button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <section
      aria-labelledby="copilot-title"
      className="rounded-3xl bg-card p-6 shadow-soft"
    >
      <h2 id="copilot-title" className="text-base font-semibold">
        Ask about this site
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The Copilot answers only from this site&apos;s reports and news, and
        links every claim to its source. Play money only; not advice.
      </p>
      {children}
    </section>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className="space-y-2">
      <p className="ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
        {turn.question}
      </p>
      <div className="max-w-[95%] rounded-2xl rounded-bl-md bg-secondary px-3.5 py-2.5 text-sm leading-relaxed">
        {turn.status === "searching" && (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Spinner aria-hidden="true" role="presentation" />
            Searching the record…
          </span>
        )}
        {turn.status === "writing" && !turn.answer && (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Spinner aria-hidden="true" role="presentation" />
            Reading {turn.sourcesFound}{" "}
            {turn.sourcesFound === 1 ? "source" : "sources"}…
          </span>
        )}
        {turn.answer && (
          <p>
            <AnswerText text={turn.answer} sources={turn.citations} />
          </p>
        )}
        {turn.status === "error" && (
          <p role="alert" className="text-destructive">
            {turn.error}
          </p>
        )}
        {turn.status === "done" && turn.citations.length > 0 && (
          <div className="mt-2.5">
            <p className="text-xs text-muted-foreground">
              {turn.mode === "extractive"
                ? "Quoted from the record:"
                : "Sources:"}
            </p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {turn.citations.map((s) => (
                <li key={s.ref} className="max-w-full min-w-0">
                  <Link
                    href={sourceHref(s)}
                    title={sourceLabel(s)}
                    className="inline-flex max-w-full items-center gap-1 rounded-full bg-card px-2.5 py-1 text-xs font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="font-mono text-muted-foreground">
                      {s.ref}
                    </span>
                    <span className="truncate">{sourceLabel(s)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** The answer with each `[ref]` as a link to its source once the citations are known. */
function AnswerText({
  text,
  sources,
}: {
  text: string;
  sources: CopilotSource[];
}) {
  return (
    <>
      {answerParts(text, sources).map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : part.source ? (
          <Link
            key={i}
            href={sourceHref(part.source)}
            aria-label={`Source ${part.ref}: ${sourceLabel(part.source)}`}
            className="mx-0.5 rounded bg-card px-1 font-mono text-xs font-medium underline-offset-2 hover:underline"
          >
            {part.ref}
          </Link>
        ) : (
          <span
            key={i}
            className="mx-0.5 font-mono text-xs text-muted-foreground"
          >
            {part.ref}
          </span>
        ),
      )}
    </>
  );
}
