"use client";

import { FlaskConical, Map as MapIcon, RotateCcw } from "lucide-react";
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
import { useWorld } from "@/lib/hooks";
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
  const signedIn = session.world?.me != null;
  const known = session.status === "ready" || session.status === "error";
  if (signedIn || !known) return <SandboxNotice />;
  return <DemoControls />;
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
  const pathname = usePathname();
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
        <p className="flex min-w-0 items-center gap-2">
          <FlaskConical
            className="size-4 shrink-0 text-lime"
            aria-hidden="true"
          />
          <span className="font-medium whitespace-nowrap">
            Demo mode · private sandbox.
          </span>
          <span className="whitespace-nowrap text-primary-foreground/75 md:hidden">
            Play money only.
          </span>
          <span className="hidden text-primary-foreground/75 md:inline">
            {SANDBOX_NOTICE} Prototype with scripted data.
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
          {!tour.active && pathname !== "/judge" && (
            <Button
              size="sm"
              variant="ghost"
              className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
              onClick={() => tour.start()}
            >
              <MapIcon aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Guided tour</span>
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
