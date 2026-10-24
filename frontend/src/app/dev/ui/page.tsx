import type { Metadata } from "next";

import {
  Lockup,
  ProofOfLifeSeal,
  ProofOfLifeShareCard,
  WildWorthMark,
} from "@/components/brand";
import { Bea, BEA_STATE_LABEL, type BeaState } from "@/components/bea/bea";
import { DataLayerPanel } from "@/components/data-layer-panel";
import { BRAND_ICONS } from "@/components/icons";
import { DemoSiteImages } from "@/components/demo-site-images";
import {
  Delta,
  LiveBadge,
  SampleTag,
  ValueRange,
  Wordmark,
} from "@/components/proto/bits";
import { GradeBadge, GradeStamp } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { VerificationBadge } from "@/components/proto/verification";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAIN_ID } from "@/components/shell/skip-link";
import { Separator } from "@/components/ui/separator";
import { GRADE_ORDER } from "@/lib/prototype/format";

export const metadata: Metadata = { title: "UI kit", robots: { index: false } };

const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "link",
  "destructive",
] as const;
const BADGE_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "destructive",
] as const;
const COLOR_TOKENS = [
  "background",
  "card",
  "foreground",
  "primary",
  "muted-foreground",
  "lichen",
  "lime",
  "lime-ink",
  "lilac",
  "clay",
  "clay-ink",
  "sky",
  "machine",
  "machine-raised",
  "machine-ink",
  "destructive",
] as const;

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </div>
  );
}

export default function DevUiPage() {
  return (
    <main
      id={MAIN_ID}
      tabIndex={-1}
      className="mx-auto w-full max-w-6xl space-y-10 px-4 py-10 outline-none sm:px-6"
    >
      <header>
        <h1 className="font-serif text-5xl">UI kit</h1>
        <p className="mt-2 text-muted-foreground">
          Every shared component and state in the WildWorth world: lichen
          ground, forest ink, lime and lilac data, clay for pressure, and the
          dark machine layer.
        </p>
      </header>

      <Section title="Type">
        <div className="space-y-2 rounded-3xl bg-card p-6 shadow-soft">
          <Wordmark app="Exchange" />
          <p className="font-serif text-5xl leading-none">
            Page title in Gloock
          </p>
          <p className="tabular text-4xl font-light">$21.47 · 76.2</p>
          <p className="max-w-prose">
            Body copy in Hanken Grotesk. Every value shows its range and
            confidence; the AI explains and audits, formulas compute.
          </p>
          <p className="text-sm text-muted-foreground">
            Secondary text in muted forest.
          </p>
        </div>
      </Section>

      <Separator />

      <Section title="Brand">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid place-items-center rounded-3xl bg-card p-8 shadow-soft">
            <Lockup size={40} />
          </div>
          <div className="grid place-items-center rounded-3xl bg-primary p-8 text-primary-foreground">
            <Lockup size={40} reading="lime" />
          </div>
          <div className="flex items-end justify-center gap-4 rounded-3xl bg-card p-8 shadow-soft">
            {[16, 24, 48].map((size) => (
              <WildWorthMark
                key={size}
                size={size}
                label={`WildWorth mark at ${size} px`}
              />
            ))}
          </div>
        </div>
      </Section>

      <Separator />

      <Section title="Proof of Life">
        <div className="grid items-center gap-4 lg:grid-cols-[auto_minmax(0,1fr)]">
          <div className="flex gap-4 rounded-3xl bg-card p-6 shadow-soft">
            <ProofOfLifeSeal
              health={77.6}
              grade="A"
              quarter="Q3 2026"
              siteName="Xochimilco wetland"
            />
            <ProofOfLifeSeal
              health={63.8}
              grade="BBB"
              quarter="Q4 2026"
              siteName="Xochimilco wetland"
            />
          </div>
          <ProofOfLifeShareCard
            siteName="Xochimilco wetland"
            health={77.6}
            grade="A"
            quarter="Q3 2026"
          />
        </div>
      </Section>

      <Separator />

      <Section title="Icons">
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8">
          {Object.entries(BRAND_ICONS).map(([key, Icon]) => (
            <li
              key={key}
              className="grid justify-items-center gap-2 rounded-2xl bg-card p-4 text-center shadow-soft"
            >
              <Icon size={28} />
              <span className="font-mono text-[11px] text-muted-foreground">
                {key}
              </span>
            </li>
          ))}
        </ul>
        <ul className="grid grid-cols-3 gap-2 rounded-3xl bg-machine p-4 text-machine-ink sm:grid-cols-6">
          {(
            ["trace", "satellite", "news", "auditor", "live", "record"] as const
          ).map((key) => {
            const Icon = BRAND_ICONS[key];
            return (
              <li key={key} className="grid justify-items-center gap-2 p-2">
                <Icon size={28} />
                <span className="font-mono text-[11px] text-machine-muted">
                  {key}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Separator />

      <Section title="Bea">
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {(Object.keys(BEA_STATE_LABEL) as BeaState[]).map((state) => (
            <li
              key={state}
              className="grid justify-items-center gap-2 rounded-2xl bg-card p-4 text-center shadow-soft"
            >
              <Bea state={state} size={96} />
              <span className="flex items-center gap-2">
                <Bea state={state} size={28} label="" />
                <span className="text-sm">{BEA_STATE_LABEL[state]}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Separator />

      <Section title="Grades">
        <div className="flex flex-wrap gap-3">
          {GRADE_ORDER.map((g) => (
            <GradeBadge key={g} grade={g} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <GradeBadge grade="A" health={76.2} showLabel size="lg" />
          <GradeStamp grade="AA" />
          <GradeStamp grade="BBB" />
        </div>
      </Section>

      <Separator />

      <Section title="Instruments">
        <div className="flex flex-wrap items-center gap-8">
          <HealthRing value={76.2} />
          <div className="rounded-3xl bg-machine p-4">
            <HealthRing value={65.8} tone="dark" size={150} />
          </div>
          <ValueRange
            low={2_121_067}
            mid={2_669_511}
            high={2_669_511}
            confidence={80}
            className="w-72"
          />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Delta value={4.2} suffix="since opening" />
          <Delta value={-6.1} />
          <Delta value={0} />
          <LiveBadge />
          <SampleTag />
          <VerificationBadge level="verified" />
          <VerificationBadge level="documents_submitted" />
          <VerificationBadge level="unverified" />
        </div>
      </Section>

      <Separator />

      <Section title="Buttons">
        <div className="flex flex-wrap gap-2">
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
          <Button disabled>disabled</Button>
          <Button className="bg-lime text-foreground hover:bg-lime/90">
            On image
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {BADGE_VARIANTS.map((variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ))}
        </div>
        <div className="grid max-w-md gap-2">
          <Input placeholder="Default input" />
          <Input aria-invalid placeholder="Invalid input" />
          <Input disabled placeholder="Disabled input" />
        </div>
      </Section>

      <Separator />

      <Section title="Colour tokens">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {COLOR_TOKENS.map((token) => (
            <li key={token} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className="size-9 rounded-xl ring-1 ring-border"
                style={{ background: `var(--${token})` }}
              />
              {token}
            </li>
          ))}
        </ul>
      </Section>

      <Separator />

      <Section title="Live API wiring (T32, T35)">
        <p className="text-sm text-muted-foreground">
          These sections call the backend through the generated client. They
          need the API running; the prototype screens use the scripted sandbox
          instead.
        </p>
        <DemoSiteImages />
        <DataLayerPanel />
      </Section>
    </main>
  );
}
