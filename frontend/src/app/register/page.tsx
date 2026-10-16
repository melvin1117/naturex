import type { Metadata } from "next";

import { AuthForm } from "@/components/proto/auth-form";

export const metadata: Metadata = { title: "Create an account" };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
