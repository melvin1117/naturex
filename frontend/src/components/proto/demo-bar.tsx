"use client";

import { FlaskConical, Map as MapIcon, RotateCcw } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "cn";

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
import { useTour } from "@/components/proto/tour";
import type { DemoPersona } from "@/lib/api/types";
import { useSwitchPersona, useWorld } from "@/lib/hooks";
import { usePrototype } from "@/lib/prototype/store";
import { PERSONAS, type PersonaKey } from "@/lib/prototype/world";

export const SANDBOX_NOTICE = "Sandbox: play money, not a real security.";

const ORDER: PersonaKey[] = ["steward", "investor", "admin"];

/**
 * The prototype's demo bar (persona switcher, Guided tour, Reset my demo) for anonymous
 * visitors. A signed-in account sees only the sandbox notice: switching personas would pretend
 * to change who they are. Until the world says who this is, only the notice shows. T65 makes
 * the demo bar real (demo sessions).
 */
export function DemoBar() {
  const session = useWorld();
  const pathname = usePathname();
  const me = session.world?.me;
  const known = session.status === "ready" || session.status === "error";
  // The story at /judge is full screen and says it's play money itself.
  if (pathname === "/judge") return null;
  if (me?.persona)
    return <DemoSessionBar persona={me.persona as DemoPersona} />;
  if (me != null || !known) return <SandboxNotice />;
  return <DemoControls />;
}

const SESSION_PERSONAS: {
  key: DemoPersona;
  name: string;
  role: string;
  home: string;
}[] = [
  { key: "rosa", name: "Rosa", role: "community steward", home: "/steward" },
  { key: "arjun", name: "Arjun", role: "supporter", home: "/" },
  { key: "admin", name: "Admin", role: "platform admin", home: "/admin" },
];

/**
 * A no-sign-up demo session (T55, T65): who you're acting as in your private sandbox, switched
 * instantly (`POST /demo/persona`), "Reset my demo" (`POST /world/reset`) and the way back to
 * the story.
 */
function DemoSessionBar({ persona }: { persona: DemoPersona }) {
  const router = useRouter();
  const switcher = useSwitchPersona();
  const { resetWorld, isResetting } = useWorld();
  const switchTo = async (p: (typeof SESSION_PERSONAS)[number]) => {
    if (p.key === persona || switcher.isPending) return;
    const world = await switcher.mutate(p.key);
    if (world) router.push(p.home);
  };
  return (
    <div
      role="region"
      aria-label="Demo mode"
      className="bg-primary text-primary-foreground"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm sm:px-6">
        <p className="flex min-w-0 items-center gap-2">
          <FlaskConical
            className="size-4 shrink-0 text-lime"
            aria-hidden="true"
          />
          <span className="font-medium">Your private sandbox.</span>
          <span className="hidden text-primary-foreground/75 md:inline">
            Live AI, play money. Nothing here is a real investment.
          </span>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="hidden text-primary-foreground/75 lg:inline">
            Acting as
          </span>
          <div
            role="radiogroup"
            aria-label="Act as"
            className="flex rounded-full bg-primary-foreground/10 p-0.5"
          >
            {SESSION_PERSONAS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={persona === p.key}
                disabled={switcher.isPending}
                onClick={() => void switchTo(p)}
                className={cn(
                  "rounded-full px-3 py-1 text-[13px] font-medium transition-colors disabled:cursor-wait",
                  persona === p.key
                    ? "bg-lime text-foreground"
                    : "text-primary-foreground/80 hover:text-primary-foreground",
                )}
              >
                {p.name}
                <span className="sr-only">, {p.role}</span>
              </button>
            ))}
          </div>
          <Button
            asChild
            size="sm"
            variant="ghost"
            className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
          >
            <Link href="/judge">
              <MapIcon aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">The story</span>
            </Link>
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                disabled={isResetting}
                className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
              >
                <RotateCcw aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">Reset my demo</span>
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
                  <Button variant="outline">Keep my demo</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button onClick={() => void resetWorld()}>
                    Reset my demo
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

function SandboxNotice() {
  return (
    <div
      role="region"
      aria-label="Sandbox notice"
      className="bg-primary text-primary-foreground"
    >
      <p className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-sm sm:px-6">
        <FlaskConical
          className="size-4 shrink-0 text-lime"
          aria-hidden="true"
        />
        <span className="font-medium">{SANDBOX_NOTICE}</span>
      </p>
    </div>
  );
}

function DemoControls() {
  const { world, setPersona, reset } = usePrototype();
  const router = useRouter();
  const tour = useTour();

  function switchTo(p: PersonaKey) {
    setPersona(p);
    if (!tour.active) router.push(PERSONAS[p].home);
  }

  return (
    <div
      role="region"
      aria-label="Demo mode"
      className="bg-primary text-primary-foreground"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm sm:px-6">
        <p className="flex min-w-0 items-start gap-2">
          <FlaskConical
            className="mt-0.5 size-4 shrink-0 text-lime"
            aria-hidden="true"
          />
          <span className="min-w-0">
            <span className="font-medium">Demo mode · private sandbox.</span>{" "}
            <span className="text-primary-foreground/75">
              {SANDBOX_NOTICE}
              <span className="hidden md:inline">
                {" "}
                Personas and the tour use a scripted demo; the marketplace is
                live.
              </span>
            </span>
          </span>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="hidden text-primary-foreground/75 lg:inline">
            Viewing as
          </span>
          <div
            role="radiogroup"
            aria-label="Switch persona"
            className="flex rounded-full bg-primary-foreground/10 p-0.5"
            data-tour="persona-switcher"
          >
            {ORDER.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={world.persona === p}
                onClick={() => switchTo(p)}
                className={cn(
                  "rounded-full px-3 py-1 text-[13px] font-medium transition-colors",
                  world.persona === p
                    ? "bg-lime text-foreground"
                    : "text-primary-foreground/80 hover:text-primary-foreground",
                )}
              >
                {PERSONAS[p].name}
                <span className="sr-only">, {PERSONAS[p].role}</span>
              </button>
            ))}
          </div>
          {!tour.active && (
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
            >
              <Link href="/judge">
                <MapIcon aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">The story</span>
              </Link>
            </Button>
          )}
          <Dialog>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
              >
                <RotateCcw aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">Reset my demo</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="rounded-3xl">
              <DialogHeader>
                <DialogTitle>Reset your sandbox?</DialogTitle>
                <DialogDescription>
                  Listings, stakes, Time Machine changes and Copilot history go
                  back to the starting world. You stay on the same persona.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Keep my demo</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button
                    onClick={() => {
                      tour.stop();
                      reset();
                    }}
                  >
                    Reset my demo
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
