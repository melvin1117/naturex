"use client";

import { safeHref } from "@/lib/safe-href";
import { Check, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import {
  type FollowUp,
  type Plan,
  type ReadFollowUp,
  type SearchFollowUp,
  modelLabel,
  monthRange,
  seconds,
  topicLabel,
} from "@/lib/trace-view";

const CHOSE: Record<string, string> = {
  search_news: "Search the news again",
  read_article: "Read an article",
  auditor: "Go to the audit",
  field_evidence: "Check the field photos",
};

/** Super's one thinking turn: what it chose, and its notes behind a toggle. */
export function PlanDetail({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <p className="text-[13px] leading-relaxed text-machine-ink/90">
        {modelLabel(plan.model)} thinks on this one turn only: it compares the
        dated satellite signals with the news it has and decides what is worth
        checking. Every other turn is a quick tool call with thinking off.
      </p>
      {plan.chose.length > 0 && (
        <ol className="mt-3 space-y-1 text-[13px] text-machine-ink">
          {plan.chose.map((c, i) => (
            <li key={`${c}-${i}`} className="flex gap-2">
              <span className="tabular text-machine-muted">{i + 1}.</span>
              {CHOSE[c] ?? c}
            </li>
          ))}
        </ol>
      )}
      {plan.notes && (
        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="-ml-3 text-machine-muted hover:bg-machine hover:text-machine-ink"
          >
            {open ? "Hide" : "Show"} its notes
            {plan.reasoningTokens
              ? ` (${plan.reasoningTokens.toLocaleString("en-US")} tokens)`
              : ""}
          </Button>
          {open && (
            <div className="mt-2 rounded-2xl bg-machine p-4">
              <p className="text-xs text-machine-muted">
                The start of its working notes, as written. It saw labels and
                counts only, never article text.
              </p>
              <p className="machine-scroll mt-3 max-h-64 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-machine-ink/90">
                {plan.notes}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Why({ text }: { text: string }) {
  if (!text) return null;
  return (
    <figure>
      <blockquote className="font-serif text-[17px] leading-snug text-machine-ink">
        “{text}”
      </blockquote>
      <figcaption className="mt-1.5 text-[11px] text-machine-muted">
        Why, in Nemotron 3 Super&apos;s words
      </figcaption>
    </figure>
  );
}

function Mark({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  const Icon = ok ? Check : X;
  return (
    <li className="flex items-start gap-2 text-[13px] text-machine-ink">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          ok ? "text-lime" : "text-clay",
        )}
        aria-hidden="true"
      />
      <span>{children}</span>
    </li>
  );
}

function SourceLink({
  url,
  children,
}: {
  url: string | null;
  children: React.ReactNode;
}) {
  const href = safeHref(url);
  if (!href) return <span className="text-machine-ink">{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex items-start gap-1 text-machine-ink underline decoration-machine-line underline-offset-2 hover:decoration-lime focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none"
    >
      <span>{children}</span>
      <ExternalLink className="mt-1 size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only"> (opens the source in a new tab)</span>
    </a>
  );
}

function SearchDetail({ f }: { f: SearchFollowUp }) {
  return (
    <div className="space-y-4">
      <Why text={f.why} />
      <dl className="space-y-1.5 text-[13px]">
        <div>
          <dt className="text-xs text-machine-muted">The signal it chased</dt>
          <dd className="text-machine-ink">{f.signalText || f.signal}</dd>
        </div>
        <div>
          <dt className="text-xs text-machine-muted">What could explain it</dt>
          <dd className="text-machine-ink">
            {topicLabel(f.topic)}
            {f.window &&
              `, news from ${monthRange(f.window.start, f.window.end)}`}
          </dd>
        </div>
      </dl>
      {f.searches.map((s) => (
        <p key={s.query} className="text-[13px] leading-snug">
          <span className="block text-machine-ink">“{s.query}”</span>
          <span className="tabular text-xs text-machine-muted">
            {s.language && s.language !== "en" ? `${s.language} · ` : ""}
            {s.error ? "failed" : `${s.results} results`} ·{" "}
            {seconds(s.latencyMs)} · {s.credits} credits
          </span>
        </p>
      ))}
      <div>
        <h5 className="mb-1.5 text-xs text-machine-muted">
          New on this site ({f.found.length})
          {f.alreadyKnown > 0 && ` · ${f.alreadyKnown} already known`}
        </h5>
        {f.found.length ? (
          <ul className="space-y-2">
            {f.found.map((item) => (
              <li key={item.event} className="text-[13px] leading-snug">
                <SourceLink url={item.url}>
                  {item.title ?? "News report"}
                </SourceLink>
                <span className="block text-[11px] text-machine-muted">
                  {[item.date, item.impactType, item.source]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-machine-muted">
            Nothing new about this site in that window: the signal stays
            unexplained by the news, which the Auditor sees too.
          </p>
        )}
      </div>
      <p className="text-xs text-machine-muted">
        Super picked the signal and the topic from fixed lists; code wrote the
        dated query, and every result went through the same safety and place
        checks as the first search.
      </p>
    </div>
  );
}

function ReadDetail({ f }: { f: ReadFollowUp }) {
  return (
    <div className="space-y-4">
      <Why text={f.why} />
      <div className="text-[13px] leading-snug">
        <SourceLink url={f.url}>{f.title ?? "The article"}</SourceLink>
        {f.publishedAt && (
          <span className="block text-[11px] text-machine-muted">
            published {f.publishedAt}
          </span>
        )}
      </div>
      <div>
        <h5 className="mb-1 text-xs text-machine-muted">The question</h5>
        <p className="text-[13px] text-machine-ink">{f.question}</p>
      </div>
      {f.status === "ok" ? (
        <>
          <div>
            <h5 className="mb-1 text-xs text-machine-muted">
              What the reader found
            </h5>
            <p className="text-[13px] leading-relaxed text-machine-ink">
              {f.finding}
            </p>
            {f.quote && (
              <blockquote className="mt-2 rounded-xl bg-machine px-3 py-2 text-[13px] leading-relaxed text-machine-ink/90 italic">
                “{f.quote}”
              </blockquote>
            )}
          </div>
          <div>
            <h5 className="mb-1.5 text-xs text-machine-muted">
              Checked by code
            </h5>
            <ul className="space-y-1">
              <Mark ok={f.namesSite}>
                {f.namesSite
                  ? "The page names the site or its town"
                  : f.modelNamesSite
                    ? "The reader said it names the site; the place check disagreed"
                    : "The page doesn't name the site"}
              </Mark>
              <Mark ok={f.quoteChecked}>
                {f.quoteChecked
                  ? "The quote is copied word for word from the page"
                  : "No quote was found word for word on the page"}
              </Mark>
              <Mark ok={Boolean(f.month)}>
                {f.month
                  ? `The event happened in ${f.month} (its year is on the page)`
                  : "No checkable date for the event"}
              </Mark>
            </ul>
          </div>
          <p className="tabular text-xs text-machine-muted">
            Tavily Extract read {f.charsRead.toLocaleString("en-US")} characters
            ranked for the question in {seconds(f.extractMs)} ({f.credits}{" "}
            credits). The page is untrusted: text that looks like instructions
            is cut before any model reads it.
          </p>
        </>
      ) : (
        <p className="text-[13px] text-machine-muted">
          The page couldn&apos;t be read ({f.error ?? "error"}); the run went on
          without it.
        </p>
      )}
    </div>
  );
}

export function FollowUpDetail({ followUp }: { followUp: FollowUp }) {
  return followUp.kind === "search" ? (
    <SearchDetail f={followUp} />
  ) : (
    <ReadDetail f={followUp} />
  );
}
