"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Wordmark } from "@/components/proto/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePrototype } from "@/lib/prototype/store";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const { setPersona } = usePrototype();
  const [error, setError] = useState<string | null>(null);
  const isRegister = mode === "register";

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const password = String(data.get("password") ?? "");
    if (isRegister && password.length < 12) {
      setError("Use at least 12 characters for your password.");
      return;
    }
    setError(null);
    toast("Accounts arrive with the backend", {
      description:
        "This prototype doesn't create accounts or send anything. Opening the Exchange as a demo investor.",
    });
    setPersona("investor");
    router.push("/");
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md">
        <Link href="/judge" className="mx-auto block w-fit">
          <Wordmark />
        </Link>
        <form
          onSubmit={onSubmit}
          className="mt-8 rounded-[1.75rem] bg-card p-6 shadow-lift sm:p-8"
          noValidate
        >
          <h1 className="font-serif text-4xl">
            {isRegister ? "Create your account" : "Sign in"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isRegister
              ? "Back sites with play money and follow their ratings. Communities can list land after signing up."
              : "Welcome back."}
          </p>
          <div className="mt-6 space-y-4">
            {isRegister && (
              <div className="space-y-2">
                <Label htmlFor="name">Display name</Label>
                <Input id="name" name="name" autoComplete="nickname" required />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={isRegister ? "new-password" : "current-password"}
                aria-describedby={isRegister ? "password-hint" : undefined}
                aria-invalid={error ? true : undefined}
                required
              />
              {isRegister && (
                <p id="password-hint" className="text-xs text-muted-foreground">
                  At least 12 characters.
                </p>
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" className="mt-6 w-full">
            {isRegister ? "Create account" : "Sign in"}
          </Button>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {isRegister ? (
              <>
                Already have an account?{" "}
                <Link
                  href="/login"
                  className="font-medium text-foreground underline"
                >
                  Sign in
                </Link>
              </>
            ) : (
              <>
                New to NatureX?{" "}
                <Link
                  href="/register"
                  className="font-medium text-foreground underline"
                >
                  Create an account
                </Link>
              </>
            )}
          </p>
        </form>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Just looking?{" "}
          <Link href="/judge" className="underline">
            Try the one-click demo
          </Link>
          . Play money only.
        </p>
      </div>
    </div>
  );
}
