"use client";

import { ArrowRight, Check } from "lucide-react";
import { useEffect, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, MyCommunity } from "@/lib/api/types";
import { useUpdateListing } from "@/lib/hooks";
import {
  detailsChanges,
  detailsHints,
  FIELD_IDS,
  firstInvalidField,
  listingFailure,
  type FieldErrors,
  type ListingDetailsForm,
  type ListingFailure,
  type ListingField,
} from "@/lib/listing";

import { FailureAlert, FieldError, StepCard } from "./shared";

function focusFirstError(errors: FieldErrors) {
  const field = firstInvalidField(errors);
  if (field) document.getElementById(FIELD_IDS[field])?.focus();
}

/** Step 1: the listing's details and, for a new listing, the community's attestation. */
export function DetailsStep({
  community,
  asset,
  form,
  onChange,
  errors,
  setErrors,
  onNext,
}: {
  community: MyCommunity;
  asset: AssetDetail | null;
  form: ListingDetailsForm;
  onChange: (patch: Partial<ListingDetailsForm>) => void;
  errors: FieldErrors;
  setErrors: (errors: FieldErrors) => void;
  onNext: () => void;
}) {
  const update = useUpdateListing();
  const [failure, setFailure] = useState<ListingFailure | null>(null);
  const described = (field: ListingField, note?: string) =>
    [errors[field] ? `${FIELD_IDS[field]}-error` : null, note]
      .filter(Boolean)
      .join(" ") || undefined;

  // Errors that sent the steward back here (a 422 from saving the boundary) take focus too.
  useEffect(() => {
    focusFirstError(errors);
    // Only when the step opens; a submit focuses its own errors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure(null);
    const hints = detailsHints(form, { needsAttestation: !asset });
    setErrors(hints);
    if (Object.keys(hints).length) return focusFirstError(hints);
    if (asset) {
      const changes = detailsChanges(asset, form);
      if (Object.keys(changes).length) {
        try {
          await update.mutateAsync({ assetId: asset.id, body: changes });
        } catch (error) {
          // The backend cleaned the text to what's already saved: nothing to change.
          if ((error as ApiError).code === "no_changes") return onNext();
          const next = listingFailure(error as ApiError);
          setErrors(next.fields);
          setFailure(next);
          return focusFirstError(next.fields);
        }
      }
    }
    onNext();
  }

  return (
    <StepCard>
      <h2 id="listing-details-title" className="mb-5 text-lg font-semibold">
        Site details
      </h2>
      <form
        className="grid gap-6 md:grid-cols-2"
        onSubmit={submit}
        noValidate
        aria-labelledby="listing-details-title"
      >
        <div className="space-y-2">
          <Label htmlFor="listing-community">Community</Label>
          <Input
            id="listing-community"
            value={community.name}
            readOnly
            aria-describedby="listing-community-note"
          />
          <p
            id="listing-community-note"
            className="text-xs text-muted-foreground"
          >
            Listed for this community. Switch community in the header.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={FIELD_IDS.name}>Site name</Label>
          <Input
            id={FIELD_IDS.name}
            value={form.name}
            onChange={(e) => onChange({ name: e.target.value })}
            maxLength={80}
            autoComplete="off"
            aria-invalid={Boolean(errors.name)}
            aria-describedby={described("name")}
            required
          />
          <FieldError id={`${FIELD_IDS.name}-error`} message={errors.name} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={FIELD_IDS.country}>Country code (optional)</Label>
          <Input
            id={FIELD_IDS.country}
            value={form.country}
            onChange={(e) => onChange({ country: e.target.value })}
            maxLength={2}
            autoComplete="off"
            spellCheck={false}
            className="uppercase"
            placeholder="MX"
            aria-invalid={Boolean(errors.country)}
            aria-describedby={described("country", "listing-country-note")}
          />
          <p
            id="listing-country-note"
            className="text-xs text-muted-foreground"
          >
            Two letters (ISO 3166), such as MX or BR.
          </p>
          <FieldError
            id={`${FIELD_IDS.country}-error`}
            message={errors.country}
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={FIELD_IDS.description}>
            What the land is and how you care for it (optional)
          </Label>
          <Textarea
            id={FIELD_IDS.description}
            rows={4}
            value={form.description}
            onChange={(e) => onChange({ description: e.target.value })}
            maxLength={1000}
            aria-invalid={Boolean(errors.description)}
            aria-describedby={described("description")}
          />
          <FieldError
            id={`${FIELD_IDS.description}-error`}
            message={errors.description}
          />
        </div>
        <div className="md:col-span-2">
          {asset ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="size-4 text-lime-ink" aria-hidden="true" />
              You confirmed your community may list this land when you saved the
              draft.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <Checkbox
                  id={FIELD_IDS.attestation}
                  checked={form.attestation}
                  onCheckedChange={(checked) =>
                    onChange({ attestation: checked === true })
                  }
                  aria-invalid={Boolean(errors.attestation)}
                  aria-describedby={described("attestation")}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={FIELD_IDS.attestation}
                  className="leading-snug font-normal"
                >
                  I confirm that {community.name} has the right to list this
                  land, and that these details are true to the best of my
                  knowledge.
                </Label>
              </div>
              <FieldError
                id={`${FIELD_IDS.attestation}-error`}
                message={errors.attestation}
              />
            </div>
          )}
        </div>
        {failure && (
          <FailureAlert
            failure={failure}
            community={community}
            className="md:col-span-2"
          />
        )}
        <div className="flex justify-end md:col-span-2">
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Continue to boundary"}
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </form>
    </StepCard>
  );
}
