"use client";

import {
  ArrowLeft,
  Compass,
  FlaskConical,
  Map as MapIcon,
  RotateCcw,
} from "lucide-react";
import NextLink from "next/link";
import { useEffect } from "react";

import { SandboxFlow, useOpenSandbox } from "@/components/sandbox/sandbox-flow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { DemoPersona } from "@/lib/api/types";
import { useSignOut, useSwitchPersona, useWorld } from "@/lib/hooks";
import { useInSandbox, useRouter } from "@/lib/nav";
import { usePrototype } from "@/lib/prototype/store";
import {
  SANDBOX_PERSONAS,
  SWITCHABLE,
  type SwitchablePersona,
} from "@/lib/sandbox-personas";

/**
 * The bar above every page. The real app has none: its homepage stays a homepage. In the
 * visitor's sandbox (`/sandbox/*`) it says where they are, who they act as (switched
 * instantly), what to try, how to reset, and the way back to NatureX.
 */
export function DemoBar() {
  const sandbox = useInSandbox();
  const { world } = useWorld();
  if (!sandbox) return <LeftoverDemoCleanup />;
  const persona = world?.me?.persona;
  if (!persona) return null; // the sandbox's own start screen explains itself
  return <SandboxBar persona={persona} />;
}

/**
 * The real app never acts as a demo persona. A browser may still hold one from before the
 * sandbox had its own address (a demo session in the real app's cookie) or be in the scripted
 * prototype demo; end both, so the visitor sees the real app.
 */
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

const ON_BAR =
  "text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground";

function SandboxBar({ persona }: { persona: DemoPersona }) {
  const router = useRouter();
  const switcher = useSwitchPersona();
  const { resetWorld, isResetting } = useWorld();
  const guide = useOpenSandbox();
  const switchTo = async (key: SwitchablePersona) => {
    if (key === persona || switcher.isPending) return;
    const world = await switcher.mutate(key);
    if (world) router.push(SANDBOX_PERSONAS[key].home);
  };
  return (
    <div
      role="region"
      aria-label="Your sandbox"
      className="bg-primary text-primary-foreground"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-sm sm:px-6">
        <Button asChild size="sm" variant="ghost" className={`-ml-2 ${ON_BAR}`}>
          {/* Leaves the sandbox on purpose: plain next/link, never the sandbox prefix. */}
          <NextLink href="/">
            <ArrowLeft aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">NatureX</span>
            <span className="sr-only">, leave the sandbox</span>
          </NextLink>
        </Button>
        <p className="flex min-w-0 items-center gap-2">
          <FlaskConical
            className="size-4 shrink-0 text-lime"
            aria-hidden="true"
          />
          <span className="font-medium">Your private sandbox</span>
          <span className="hidden text-primary-foreground/75 2xl:inline">
            · live AI, play money
          </span>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <span className="hidden text-primary-foreground/75 2xl:inline">
            Acting as
          </span>
          <ToggleGroup
            type="single"
            value={persona}
            onValueChange={(v) => {
              const key = SWITCHABLE.find((k) => k === v);
              if (key) void switchTo(key);
            }}
            disabled={switcher.isPending}
            aria-label="Act as"
            className="rounded-full bg-primary-foreground/10 p-0.5"
          >
            {SWITCHABLE.map((key) => {
              const p = SANDBOX_PERSONAS[key];
              return (
                <ToggleGroupItem
                  key={key}
                  value={key}
                  aria-label={`${p.name} (${p.role})`}
                  className="h-7 rounded-full px-3 text-[13px] font-medium text-primary-foreground/80 hover:bg-transparent hover:text-primary-foreground data-[state=on]:bg-lime data-[state=on]:text-foreground"
                >
                  {p.name}
                  <span className="hidden font-normal opacity-75 lg:inline">
                    ({p.role})
                  </span>
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className={ON_BAR}>
                <Compass aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">What to try</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[min(26rem,calc(100vw-2rem))] rounded-3xl p-3"
            >
              <p className="px-1.5 pt-1 pb-2.5 text-sm text-muted-foreground">
                NatureX&apos;s loop, step by step. Each step opens its screen as
                the right person; go anywhere from there.
              </p>
              <SandboxFlow sandbox={guide} tone="light" />
            </PopoverContent>
          </Popover>
          <Button asChild size="sm" variant="ghost" className={ON_BAR}>
            <NextLink href="/judge">
              <MapIcon aria-hidden="true" />
              <span className="sr-only 2xl:not-sr-only">The story</span>
            </NextLink>
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                disabled={isResetting}
                className={ON_BAR}
              >
                <RotateCcw aria-hidden="true" />
                <span className="sr-only 2xl:not-sr-only">Reset</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="rounded-3xl">
              <DialogHeader>
                <DialogTitle>Reset your sandbox?</DialogTitle>
                <DialogDescription>
                  Listings, stakes, Time Machine changes and Copilot history go
                  back to the starting world. You stay who you are now.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Keep my sandbox</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button onClick={() => void resetWorld()}>
                    Reset my sandbox
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      {switcher.error && (
        <p
          role="alert"
          className="mx-auto max-w-7xl px-4 pb-2 text-sm text-lime sm:px-6"
        >
          Couldn&apos;t switch just now. Try again.
        </p>
      )}
    </div>
  );
}
