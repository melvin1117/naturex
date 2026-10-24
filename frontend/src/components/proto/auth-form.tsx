"use client";

import { TriangleAlertIcon } from "lucide-react";
import Link from "@/components/app-link";
import { useRouter } from "@/lib/nav";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Wordmark } from "@/components/proto/bits";
import { PasswordField } from "@/components/proto/password-field";
import { useTour } from "@/components/proto/tour";
import { MAIN_ID } from "@/components/shell/skip-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { toApiError } from "@/lib/api/errors";
import { WELCOME_TOAST_MS } from "@/lib/feedback";
import { clearFills } from "@/lib/trade";
import {
  authFailure,
  LOGIN_PATH,
  PASSWORD_RULE,
  REGISTER_PATH,
  safeReturnPath,
  validateAuthInput,
  withNext,
  type AuthField,
  type AuthMode,
  type FieldErrors,
} from "@/lib/auth";
import { useRegister, useSignIn, useWorld } from "@/lib/hooks";
import { usePrototype } from "@/lib/prototype/store";

const FIELD_ORDER: AuthField[] = ["name", "email", "password"];
const FORM_ERROR_ID = "form-error";

/**
 * `/login` and `/register` (T61), on the real auth API. The session is the HttpOnly
 * `nx_session` cookie the backend sets; this form never sees or stores a token. After success
 * it goes to `next` if that's a safe same-origin path, else the Exchange.
 */
export function AuthForm({
  mode,
  next,
}: {
  mode: AuthMode;
  /** The page that sent the visitor here (`?next=`); validated before use. */
  next?: string;
}) {
  const router = useRouter();
  const { exitDemo } = usePrototype();
  const tour = useTour();
  const { world } = useWorld();
  const signIn = useSignIn();
  const register = useRegister();
  const mutation = mode === "register" ? register : signIn;
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Where focus goes after a failed submit, applied once the errors have rendered.
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  // Until React has hydrated, a submit would skip validation and our handler; keep it off.
  const [hydrated, setHydrated] = useState(false);
  const submitting = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const isRegister = mode === "register";
  const destination = safeReturnPath(next);
  const signedIn = world?.me != null;

  // Already signed in (or just signed in): go where the visitor was heading.
  useEffect(() => {
    if (signedIn) router.replace(destination);
  }, [signedIn, destination, router]);

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (focusRequest)
      formRef.current
        ?.querySelector<HTMLElement>(`#${focusRequest.id}`)
        ?.focus();
  }, [focusRequest]);

  /** The first invalid field; else the password after wrong credentials; else the alert. */
  function focusAfterError(errors: FieldErrors, status?: number) {
    const id =
      FIELD_ORDER.find((field) => errors[field]) ??
      (status === 401 ? "password" : FORM_ERROR_ID);
    setFocusRequest({ id });
  }

  function clearFieldError(field: AuthField) {
    setFieldErrors((errors) =>
      errors[field] ? { ...errors, [field]: undefined } : errors,
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current) return;
    const data = new FormData(e.currentTarget);
    const input = {
      name: String(data.get("name") ?? ""),
      email: String(data.get("email") ?? "").trim(),
      password: String(data.get("password") ?? ""),
    };
    const invalid = validateAuthInput(mode, input);
    setFormError(null);
    setFieldErrors(invalid);
    if (Object.keys(invalid).length) {
      focusAfterError(invalid);
      return;
    }
    submitting.current = true;
    try {
      const me = isRegister
        ? await register.mutateAsync({
            name: input.name.trim(),
            email: input.email,
            password: input.password,
          })
        : await signIn.mutateAsync({
            email: input.email,
            password: input.password,
          });
      tour.stop();
      exitDemo();
      // A new session: the previous account's recent fills aren't news for this one.
      clearFills();
      toast(
        isRegister
          ? `Welcome to NatureX, ${me.name}`
          : `Welcome back, ${me.name}`,
        {
          description: "Play money only, not a real security.",
          duration: WELCOME_TOAST_MS,
        },
      );
      router.replace(destination);
    } catch (error) {
      const apiError = toApiError(error);
      const failure = authFailure(mode, apiError);
      setFormError(failure.form);
      setFieldErrors(failure.fields);
      focusAfterError(failure.fields, apiError.status);
    } finally {
      submitting.current = false;
    }
  }

  // A form-level error (wrong credentials, network) describes every field, so it's heard again
  // when the visitor moves back into the form, not only when the alert first appears.
  const formErrorRef = formError ? FORM_ERROR_ID : undefined;
  const fieldProps = (field: AuthField) => ({
    "aria-invalid": fieldErrors[field] ? true : undefined,
    "aria-describedby":
      [fieldErrors[field] && `${field}-error`, formErrorRef]
        .filter(Boolean)
        .join(" ") || undefined,
    onChange: () => clearFieldError(field),
  });

  return (
    <main
      id={MAIN_ID}
      tabIndex={-1}
      className="flex flex-1 items-center justify-center px-4 py-16 outline-none"
    >
      <div className="w-full max-w-md">
        <Link href="/judge" className="mx-auto block w-fit">
          <Wordmark />
        </Link>
        <form
          ref={formRef}
          // A submit before hydration posts instead of putting the password in the URL.
          method="post"
          onSubmit={onSubmit}
          className="mt-8 rounded-[1.75rem] bg-card p-6 shadow-lift sm:p-8"
          aria-busy={mutation.isPending || undefined}
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
                <Input
                  id="name"
                  name="name"
                  autoComplete="nickname"
                  required
                  {...fieldProps("name")}
                />
                <FieldError field="name" message={fieldErrors.name} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                {...fieldProps("email")}
              />
              <FieldError field="email" message={fieldErrors.email} />
            </div>
            <PasswordField
              autoComplete={isRegister ? "new-password" : "current-password"}
              hint={isRegister ? PASSWORD_RULE : undefined}
              error={fieldErrors.password}
              describedBy={formErrorRef}
              onEdit={() => clearFieldError("password")}
            />
          </div>
          {formError && (
            <Alert
              id={FORM_ERROR_ID}
              tabIndex={-1}
              variant="destructive"
              className="mt-4 rounded-xl"
            >
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <Button
            type="submit"
            size="lg"
            className="mt-6 w-full"
            disabled={!hydrated || mutation.isPending}
          >
            {mutation.isPending && (
              <Spinner aria-hidden="true" role="presentation" />
            )}
            {mutation.isPending
              ? isRegister
                ? "Creating your account…"
                : "Signing in…"
              : isRegister
                ? "Create account"
                : "Sign in"}
          </Button>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {isRegister ? "Already have an account? " : "New to NatureX? "}
            <Link
              href={withNext(isRegister ? LOGIN_PATH : REGISTER_PATH, next)}
              className="font-medium text-foreground underline"
            >
              {isRegister ? "Sign in" : "Create an account"}
            </Link>
          </p>
        </form>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Just looking?{" "}
          <Link href="/judge" className="underline">
            Take the guided demo tour
          </Link>
          . Play money only.
        </p>
      </div>
    </main>
  );
}

function FieldError({
  field,
  message,
}: {
  field: AuthField;
  message?: string;
}) {
  if (!message) return null;
  return (
    <p id={`${field}-error`} className="text-sm text-destructive">
      {message}
    </p>
  );
}
