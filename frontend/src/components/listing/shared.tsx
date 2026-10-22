"use client";

import { FlaskConical, LogIn, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "cn";

import { PageSkeleton } from "@/components/page-skeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MyCommunity } from "@/lib/api/types";
import { loginHref } from "@/lib/auth";
import {
  listingsHref,
  type ListingFailure,
  type PolygonProblem,
} from "@/lib/listing";

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-6xl px-4 pt-10 sm:px-6">{children}</div>;
}

/**
 * The listing page while its session or listing loads: the shape the route's `loading.tsx`
 * drew (`PageSkeleton`), so it goes from skeleton to content without a spinner between (#219).
 */
export function Loading({ children }: { children: string }) {
  return <PageSkeleton label={children} />;
}

export function StepCard({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "rounded-[1.75rem] bg-card p-6 shadow-soft sm:p-8",
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  );
}

function currentPath(): string {
  if (typeof window === "undefined") return "/steward/list";
  const { pathname, search } = window.location;
  return `${pathname}${search}`;
}

export function FailureAlert({
  failure,
  community,
  className,
}: {
  failure: ListingFailure;
  community: MyCommunity;
  className?: string;
}) {
  return (
    <Alert variant="destructive" className={className}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{failure.title}</AlertTitle>
      <AlertDescription>
        <p>{failure.message}</p>
        {failure.limitReached && (
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href={listingsHref(community.id)}>See your listings</Link>
          </Button>
        )}
        {failure.signIn && (
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href={loginHref(currentPath())}>
              <LogIn aria-hidden="true" />
              Sign in again
            </Link>
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function PolygonProblems({ problems }: { problems: PolygonProblem[] }) {
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>NatureX couldn&apos;t accept this boundary</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {problems.map((problem, i) => (
            <li key={`${problem.code}-${i}`}>
              <span className="font-medium">{problem.title}.</span>{" "}
              {problem.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export function MockBadge() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-dashed"
      title="Rated from placeholder metrics (USE_MOCKS), not satellite observations"
    >
      <FlaskConical aria-hidden="true" />
      Mock data
    </Badge>
  );
}
