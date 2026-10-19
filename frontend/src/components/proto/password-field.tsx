"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Password input with a show/hide toggle. The value never leaves the form element. */
export function PasswordField({
  autoComplete,
  hint,
  error,
  onEdit,
}: {
  autoComplete: "current-password" | "new-password";
  hint?: string;
  error?: string;
  onEdit: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const describedBy =
    [hint && "password-hint", error && "password-error"]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className="space-y-2">
      <Label htmlFor="password">Password</Label>
      <div className="relative">
        <Input
          id="password"
          name="password"
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onChange={onEdit}
          required
          className="pr-12"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
          aria-controls="password"
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          <span className="sr-only">Show password</span>
        </Button>
      </div>
      {hint && (
        <p id="password-hint" className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id="password-error" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
