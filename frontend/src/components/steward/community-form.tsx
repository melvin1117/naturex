"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toApiError } from "@/lib/api/errors";
import type { CommunityOut } from "@/lib/api/types";
import {
  communityBody,
  communityFailure,
  DESCRIPTION_MAX,
  NAME_MAX,
  validateCommunity,
  type CommunityErrors,
  type CommunityInput,
} from "@/lib/community";
import { useCreateCommunity, useUpdateCommunity } from "@/lib/community-hooks";

type Body = ReturnType<typeof communityBody>;

/**
 * Name, country and description, checked like the backend before sending; the API's refusals
 * (a taken name, the 5-community cap, 422s) show on the field they concern or above the button.
 */
function CommunityFields({
  initial,
  submitLabel,
  pendingLabel,
  onSubmit,
}: {
  initial: CommunityInput;
  submitLabel: string;
  pendingLabel: string;
  /** Throws the `ApiError` on failure. */
  onSubmit: (body: Body) => Promise<void>;
}) {
  const ids = useId();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<CommunityErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = (field: keyof CommunityInput) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const found = validateCommunity(values);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`${ids}-${first}`)?.focus();
      return;
    }
    setPending(true);
    try {
      await onSubmit(communityBody(values));
    } catch (error) {
      const failure = communityFailure(toApiError(error));
      if (failure.field) {
        setErrors({ [failure.field]: failure.message });
        document.getElementById(`${ids}-${failure.field}`)?.focus();
      } else {
        setFormError(failure.message);
      }
    } finally {
      setPending(false);
    }
  }

  const field = (name: keyof CommunityInput) => ({
    id: `${ids}-${name}`,
    name,
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": `${ids}-${name}-hint`,
  });
  const hint = (name: keyof CommunityInput, text: string) => (
    <p
      id={`${ids}-${name}-hint`}
      className={
        errors[name]
          ? "text-sm text-destructive"
          : "text-xs text-muted-foreground"
      }
    >
      {errors[name] ?? text}
    </p>
  );

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor={`${ids}-name`}>Community name</Label>
        <Input
          {...field("name")}
          autoComplete="organization"
          maxLength={200}
          value={values.name}
          onChange={(e) => set("name")(e.target.value)}
          required
        />
        {hint(
          "name",
          `Up to ${NAME_MAX} characters. Supporters see it on your sites.`,
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${ids}-country`}>
          Country <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          {...field("country")}
          autoComplete="country"
          className="w-24 uppercase"
          maxLength={2}
          spellCheck={false}
          value={values.country}
          onChange={(e) => set("country")(e.target.value)}
        />
        {hint("country", "Two-letter code, like MX or KE.")}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${ids}-description`}>
          About the community{" "}
          <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          {...field("description")}
          rows={4}
          value={values.description}
          onChange={(e) => set("description")(e.target.value)}
        />
        {hint(
          "description",
          `${values.description.trim().length}/${DESCRIPTION_MAX} characters. Who you are and the land you look after.`,
        )}
      </div>
      {formError && (
        <Alert variant="destructive" role="alert">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}

/** `POST /communities`; `onCreated` gets the new community (e.g. to show it). */
export function CreateCommunityForm({
  onCreated,
}: {
  onCreated: (community: CommunityOut) => void;
}) {
  const create = useCreateCommunity();
  return (
    <CommunityFields
      initial={{ name: "", country: "", description: "" }}
      submitLabel="Create community"
      pendingLabel="Creating…"
      onSubmit={async (body) => {
        onCreated(await create.mutateAsync(body));
      }}
    />
  );
}

/** `PATCH /communities/{id}` (owner only); sends only what changed. */
export function EditCommunityForm({
  community,
  onSaved,
}: {
  community: Pick<CommunityOut, "id" | "name" | "country" | "description">;
  onSaved: (community: CommunityOut) => void;
}) {
  const update = useUpdateCommunity(community.id);
  return (
    <CommunityFields
      // A saved change (or another tab's) resets the fields to the stored values.
      key={[
        community.id,
        community.name,
        community.country,
        community.description,
      ].join("\u0000")}
      initial={{
        name: community.name,
        country: community.country ?? "",
        description: community.description ?? "",
      }}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      onSubmit={async (body) => {
        const changed: Partial<Body> = {};
        if (body.name !== community.name) changed.name = body.name;
        if (body.country !== (community.country ?? null))
          changed.country = body.country;
        if (body.description !== (community.description ?? null))
          changed.description = body.description;
        onSaved(await update.mutateAsync(changed));
      }}
    />
  );
}
