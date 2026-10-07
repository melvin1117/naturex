import type { Metadata } from "next";

import { DataLayerPanel } from "@/components/data-layer-panel";
import { SandboxBanner } from "@/components/sandbox-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

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
  "foreground",
  "primary",
  "secondary",
  "muted",
  "accent",
  "destructive",
  "border",
] as const;

export default function DevUiPage() {
  return (
    <section className="mx-auto w-full max-w-6xl space-y-10 px-4 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">UI kit</h1>
        <p className="mt-2 text-muted-foreground">
          Every shared component and state. T21 replaces the default tokens with
          the P04 design system.
        </p>
      </header>

      <div className="space-y-3">
        <h2 className="text-xl font-semibold">Buttons</h2>
        <div className="flex flex-wrap gap-2">
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
          <Button disabled>disabled</Button>
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <h2 className="text-xl font-semibold">Badges</h2>
        <div className="flex flex-wrap gap-2">
          {BADGE_VARIANTS.map((variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ))}
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <h2 className="text-xl font-semibold">Card</h2>
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Example asset</CardTitle>
            <CardDescription>Grade AA · confidence 72%</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            Sample text only; real cards come in T22.
          </CardContent>
        </Card>
      </div>

      <Separator />

      <div className="space-y-3">
        <h2 className="text-xl font-semibold">Sandbox banner</h2>
        <SandboxBanner />
      </div>

      <Separator />

      <div className="space-y-3">
        <h2 className="text-xl font-semibold">Data layer</h2>
        <DataLayerPanel />
      </div>

      <Separator />

      <div className="space-y-3">
        <h2 className="text-xl font-semibold">Colour tokens</h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {COLOR_TOKENS.map((token) => (
            <li key={token} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className="size-8 rounded-md border"
                style={{ background: `var(--${token})` }}
              />
              {token}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
