import type { Metadata } from "next";

import { AuthForm } from "@/components/proto/auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { next } = await searchParams;
  // AuthForm validates it (same-origin relative paths only) before redirecting.
  return (
    <AuthForm mode="login" next={typeof next === "string" ? next : undefined} />
  );
}
