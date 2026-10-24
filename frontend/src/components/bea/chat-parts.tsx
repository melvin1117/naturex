"use client";

import { ArrowUp } from "lucide-react";
import { useId, type FormEvent, type ReactNode } from "react";

import { Bea, type BeaState } from "@/components/bea/bea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BEA_MODEL } from "@/lib/bea";
import { modelLabel } from "@/lib/trace-view";

/*
 * Bea's chat, as the character sheet's product mock draws it (bea-character.html, chapter 6):
 * the reader's questions in forest bubbles on the right; Bea's answers in paper bubbles beside
 * her avatar, sources as small chips; what she's doing as a quiet line; an inset field, and a
 * footnote that says what she runs on. The real chat and the scripted preview share these.
 */

/** "Play money only; not advice." Bea never gives advice, and her world is play money. */
export const NOT_ADVICE = "Play money only; not advice.";

export function BeaQuestion({ children }: { children: ReactNode }) {
  return (
    <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm leading-snug text-pretty text-primary-foreground">
      {children}
    </p>
  );
}

/** Bea beside her answer (or beside what she's doing, with `bubble={false}`). */
export function BeaAnswer({
  state,
  react,
  bubble = true,
  meta,
  children,
}: {
  state: BeaState;
  react?: "up" | "down" | null;
  bubble?: boolean;
  /** Under the bubble: how the answer was made. */
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5">
      <Bea state={state} size={34} react={react} label="" />
      <div className="min-w-0">
        {bubble ? (
          <div className="w-fit max-w-full rounded-2xl rounded-bl-sm bg-card px-3.5 py-3 text-sm leading-relaxed text-pretty">
            {children}
          </div>
        ) : (
          <div className="pt-2 text-[13px] text-muted-foreground">
            {children}
          </div>
        )}
        {meta}
      </div>
    </div>
  );
}

/** A source chip under an answer: the ref in lime-ink mono (where the real chat has one), then the label. */
export const SOURCE_CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** Before the first question: Bea, what to ask her, and a few questions to start with. */
export function BeaEmpty({
  state,
  react,
  title,
  children,
  suggestions,
  compact = false,
}: {
  state: BeaState;
  react?: "up" | "down" | null;
  title: string;
  children: ReactNode;
  suggestions?: ReactNode;
  /** In a card on a page: Bea beside the words instead of above them. */
  compact?: boolean;
}) {
  if (compact)
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Bea state={state} size={48} react={react} label="" />
          <p className="min-w-0 font-serif text-xl leading-tight text-balance">
            {title}
          </p>
        </div>
        <p className="text-[13.5px] text-pretty text-muted-foreground">
          {children}
        </p>
        {suggestions && (
          <div className="flex flex-wrap gap-1.5">{suggestions}</div>
        )}
      </div>
    );
  return (
    <div className="grid justify-items-center gap-3 px-2 pt-6 pb-2 text-center">
      <Bea state={state} size={110} react={react} label="" />
      <p className="font-serif text-[22px] leading-tight text-balance">
        {title}
      </p>
      <p className="max-w-[34ch] text-[13.5px] text-pretty text-muted-foreground">
        {children}
      </p>
      {suggestions && (
        <div className="flex flex-wrap justify-center gap-1.5 pt-1">
          {suggestions}
        </div>
      )}
    </div>
  );
}

/** A question to start with, as a chip. */
export function BeaSuggestion({
  children,
  onClick,
  disabled,
}: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-auto rounded-full px-3 py-1.5 text-[12.5px] font-normal"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * The question field: paper, inset, with the send button inside it, and the footnote under it
 * (what Bea answers from, the model she runs on, that it's play money and never advice).
 */
export function BeaComposer({
  value,
  onChange,
  onSubmit,
  label,
  placeholder,
  sendDisabled,
  maxLength,
  tourAnchor,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  label: string;
  placeholder: string;
  sendDisabled?: boolean;
  maxLength?: number;
  /** Guided-tour anchor (`data-tour`) on the field. */
  tourAnchor?: string;
}) {
  const id = useId();
  return (
    <div>
      <form
        className="relative"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <Input
          id={id}
          value={value}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          data-tour={tourAnchor}
          className="h-12 rounded-2xl pr-14 pl-4 shadow-none"
        />
        <Button
          type="submit"
          size="icon-sm"
          aria-label="Send question"
          disabled={sendDisabled}
          className="absolute top-2 right-2 rounded-full"
        >
          <ArrowUp aria-hidden="true" />
        </Button>
      </form>
      <p className="mt-2 px-1 font-mono text-[10.5px] leading-snug tracking-[0.02em] text-muted-foreground">
        Runs on NVIDIA {modelLabel(BEA_MODEL)} · {NOT_ADVICE}
      </p>
    </div>
  );
}
