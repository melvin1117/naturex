"use client";

import {
  BadgeCheck,
  Check,
  ChevronDown,
  LogOut,
  RotateCcw,
} from "lucide-react";
import NextLink from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "cn";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSwitchPersona, useWorld } from "@/lib/hooks";
import { useRouter } from "@/lib/nav";
import {
  SANDBOX_PERSONAS,
  SWITCHABLE,
  type SwitchablePersona,
} from "@/lib/sandbox-personas";

/** A person's round avatar: their initial, or a check for the Reviewer. */
export function PersonaAvatar({
  persona,
  className,
}: {
  persona: SwitchablePersona;
  className?: string;
}) {
  // The initial is drawn by CSS, not as text, so it never joins a button's visible name.
  const initial =
    persona === "admin" ? undefined : SANDBOX_PERSONAS[persona].name[0];
  return (
    <span
      aria-hidden="true"
      data-initial={initial}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold",
        initial && "before:content-[attr(data-initial)]",
        persona === "admin"
          ? "bg-machine text-lime"
          : persona === "rosa"
            ? "bg-lime/60 text-foreground"
            : "bg-primary text-primary-foreground",
        className,
      )}
    >
      {persona === "admin" && <BadgeCheck className="size-4" />}
    </span>
  );
}

/**
 * Who the visitor is in their sandbox, switched instantly (no sign-in), with the sandbox's own
 * controls: start it over, or leave for the welcome. Switching goes to that person's home.
 */
export function PersonaMenu({ persona }: { persona: SwitchablePersona }) {
  const router = useRouter();
  const switcher = useSwitchPersona();
  const { resetWorld, isResetting } = useWorld();
  const [confirmReset, setConfirmReset] = useState(false);
  const me = SANDBOX_PERSONAS[persona];

  const switchTo = async (key: SwitchablePersona) => {
    if (key === persona || switcher.isPending) return;
    const world = await switcher.mutate(key);
    if (world) router.push(SANDBOX_PERSONAS[key].home);
    else
      toast(`Couldn't switch to ${SANDBOX_PERSONAS[key].name} just now`, {
        description: "Try again in a moment.",
      });
  };

  const startOver = async () => {
    const world = await resetWorld();
    if (world) router.push(me.home);
    else
      toast("Couldn't start the sandbox over just now", {
        description: "Nothing changed. Try again in a moment.",
      });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-11 gap-2 rounded-full py-1 pr-2.5 pl-1.5"
            disabled={switcher.isPending}
            aria-label={`You're ${me.name}, ${me.role}. Switch person or reset the sandbox`}
          >
            <PersonaAvatar persona={persona} />
            <span className="hidden flex-col items-start leading-tight sm:flex">
              <span className="text-[13.5px] font-semibold">{me.name}</span>{" "}
              <span className="text-[11.5px] font-normal text-muted-foreground">
                {me.role}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 rounded-2xl p-1.5">
          <DropdownMenuLabel className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
            Be someone else
          </DropdownMenuLabel>
          {SWITCHABLE.map((key) => {
            const p = SANDBOX_PERSONAS[key];
            const current = key === persona;
            return (
              <DropdownMenuItem
                key={key}
                onSelect={() => void switchTo(key)}
                className="gap-3 rounded-xl px-2.5 py-2"
                aria-current={current ? "true" : undefined}
              >
                <PersonaAvatar persona={key} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {p.name}{" "}
                    <span className="font-normal text-muted-foreground">
                      · {p.role}
                    </span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.blurb}
                  </span>
                </span>
                {current && (
                  <Check aria-hidden="true" className="size-4 text-lime-ink" />
                )}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator className="my-1.5" />
          <DropdownMenuItem
            className="gap-3 rounded-xl px-2.5 py-2"
            disabled={isResetting}
            onSelect={() => setConfirmReset(true)}
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Start the sandbox over
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="gap-3 rounded-xl px-2.5 py-2">
            {/* Leaves the sandbox on purpose: plain next/link, never the sandbox prefix. */}
            <NextLink href="/">
              <LogOut aria-hidden="true" className="size-4" />
              Leave the sandbox
            </NextLink>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Start the sandbox over?</AlertDialogTitle>
            <AlertDialogDescription>
              New communities, listings, stakes and Time Machine changes are
              cleared. The three demo sites come back as they started.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void startOver()}>
              Start over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
