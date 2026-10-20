/** The listing's details form: hints, the create body and the fields an edit changes. */
import type { AssetDetail, AssetUpdate } from "../api/types";

export interface ListingDetailsForm {
  name: string;
  country: string;
  description: string;
  attestation: boolean;
}

export type ListingField = "name" | "country" | "description" | "attestation";
export type FieldErrors = Partial<Record<ListingField, string>>;

/** The form's input IDs, in the order a steward meets them (focus goes to the first error). */
export const FIELD_IDS: Record<ListingField, string> = {
  name: "listing-name",
  country: "listing-country",
  description: "listing-description",
  attestation: "listing-attestation",
};

/** The first field with an error, in form order. */
export function firstInvalidField(errors: FieldErrors): ListingField | null {
  return (
    (Object.keys(FIELD_IDS) as ListingField[]).find((field) => errors[field]) ??
    null
  );
}

/** Hints mirroring the backend's checks (it re-checks everything). */
export function detailsHints(
  form: ListingDetailsForm,
  { needsAttestation }: { needsAttestation: boolean },
): FieldErrors {
  const errors: FieldErrors = {};
  const name = form.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) errors.name = "Use 2–80 characters.";
  const country = form.country.trim();
  if (country && !/^[A-Za-z]{2}$/.test(country))
    errors.country = "Use a two-letter country code, such as MX.";
  if (form.description.trim().length > 1000)
    errors.description = "Use at most 1,000 characters.";
  if (needsAttestation && !form.attestation)
    errors.attestation = "Confirm your community may list this land.";
  return errors;
}

function optional(text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/** The create body's details, cleaned as the backend expects. */
export function detailsBody(form: ListingDetailsForm) {
  return {
    name: form.name.trim().replace(/\s+/g, " "),
    country: optional(form.country)?.toUpperCase() ?? null,
    description: optional(form.description),
  };
}

/** Only what changed (the backend refuses an edit that changes nothing). */
export function detailsChanges(
  asset: Pick<AssetDetail, "name" | "country" | "description">,
  form: ListingDetailsForm,
): AssetUpdate {
  const next = detailsBody(form);
  const changes: AssetUpdate = {};
  if (next.name !== asset.name) changes.name = next.name;
  if (next.country !== (asset.country ?? null)) changes.country = next.country;
  if (next.description !== (asset.description ?? null))
    changes.description = next.description;
  return changes;
}
