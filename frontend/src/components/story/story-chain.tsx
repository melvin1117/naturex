"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { GradeBadge } from "@/components/proto/grade";
import type { Grade } from "@/lib/site-data";
import { dollars } from "@/lib/story";

export type ChainState = {
  health: { value: string; delta?: string } | null;
  grade: Grade | null;
  price: { value: string; delta?: string } | null;
  fund: number;
};

export const EMPTY_CHAIN: ChainState = {
  health: null,
  grade: null,
  price: null,
  fund: 0,
};

/** Re-render a cell's flash whenever `value` changes (not on first paint). */
function useFlash(value: unknown): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOn(true);
    const t = setTimeout(() => setOn(false), 900);
    return () => clearTimeout(t);
  }, [value]);
  return on;
}

function useCountUp(to: number, reducedMotion: boolean): number {
  const [shown, setShown] = useState(to);
  const from = useRef(to);
  useEffect(() => {
    if (reducedMotion) {
      setShown(to);
      from.current = to;
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 1100);
      const eased = 1 - (1 - t) ** 3;
      setShown(origin + (to - origin) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = to;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [to, reducedMotion]);
  return shown;
}

function Delta({ text }: { text?: string }) {
  if (!text) return null;
  const down = text.startsWith("−");
  return (
    <span
      className={cn(
        "ml-1.5 font-sans text-[13px] font-medium",
        down ? "text-clay" : "text-lime",
      )}
    >
      {text}
    </span>
  );
}

function Cell({
  label,
  flash,
  children,
}: {
  label: string;
  flash: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "min-w-[7.5rem] rounded-2xl px-3.5 py-2 transition-colors duration-500 sm:min-w-[9rem] sm:px-4",
        flash && "bg-machine-raised",
      )}
    >
      <p className="text-xs text-machine-muted">{label}</p>
      <div className="mt-0.5 flex h-9 items-center font-serif text-[1.65rem] leading-none whitespace-nowrap tabular-nums">
        {children}
      </div>
    </div>
  );
}

function Link({ lit }: { lit: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative grid w-6 shrink-0 place-items-center transition-colors duration-500",
        lit ? "text-lime" : "text-machine-line",
      )}
    >
      <ChevronRight className="size-4" />
    </span>
  );
}

const Empty = () => <span className="text-machine-line">?</span>;

/**
 * The chain the whole story is about: land health sets the rating, the rating sets the price,
 * supporters' money reaches the community. Each step of the story fills or moves a link.
 */
export function StoryChain({
  chain,
  reducedMotion,
}: {
  chain: ChainState;
  reducedMotion: boolean;
}) {
  const fund = useCountUp(chain.fund, reducedMotion);
  const flash = {
    health: useFlash(chain.health?.value),
    grade: useFlash(chain.grade),
    price: useFlash(chain.price?.value),
    fund: useFlash(chain.fund),
  };
  return (
    <section
      aria-label="How the land's health reaches its community"
      // On a phone the chain scrolls sideways: the keyboard can reach and scroll it too.
      tabIndex={0}
      className="pointer-events-auto flex max-w-full items-stretch overflow-x-auto rounded-3xl bg-machine p-2 text-machine-ink shadow-[0_18px_44px_-16px_rgba(0,0,0,0.65)] outline-none focus-visible:ring-2 focus-visible:ring-lime"
    >
      <Cell label="Land health" flash={flash.health}>
        {chain.health ? (
          <>
            {chain.health.value}
            <Delta text={chain.health.delta} />
          </>
        ) : (
          <Empty />
        )}
      </Cell>
      <Link lit={chain.grade !== null} />
      <Cell label="Rating" flash={flash.grade}>
        {chain.grade ? <GradeBadge grade={chain.grade} size="md" /> : <Empty />}
      </Cell>
      <Link lit={chain.price !== null} />
      <Cell label="Price a unit" flash={flash.price}>
        {chain.price ? (
          <>
            {dollars(chain.price.value)}
            <Delta text={chain.price.delta} />
          </>
        ) : (
          <Empty />
        )}
      </Cell>
      <Link lit={chain.fund > 0} />
      <Cell label="Community fund" flash={flash.fund}>
        {dollars(fund)}
      </Cell>
    </section>
  );
}
