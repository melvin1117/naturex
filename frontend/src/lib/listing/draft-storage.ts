/**
 * A new listing not saved yet, kept in this tab's `sessionStorage` so it survives a sign-in
 * (a 401 while saving) or a reload. Per account and community; the attestation is never kept,
 * so it's confirmed again. Cleared once the draft exists on the server.
 */
import type { LatLng } from "../prototype/data";
import type { ListingDetailsForm } from "./details";
import { MAX_BOUNDARY_POINTS } from "./boundary";

export interface UnsavedListing {
  form: Omit<ListingDetailsForm, "attestation">;
  points: LatLng[];
}

const PREFIX = "ww-listing-draft:";

export function unsavedListingKey(meId: string, communityId: string): string {
  return `${PREFIX}${meId}:${communityId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isPoint(value: unknown): value is LatLng {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export function readUnsavedListing(key: string): UnsavedListing | null {
  const raw = storage()?.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as {
      form?: Record<string, unknown>;
      points?: unknown;
    };
    const text = (field: string) =>
      typeof value.form?.[field] === "string"
        ? (value.form[field] as string)
        : "";
    const points = Array.isArray(value.points) ? value.points : [];
    if (points.length > MAX_BOUNDARY_POINTS || !points.every(isPoint))
      return null;
    return {
      form: {
        name: text("name"),
        country: text("country"),
        description: text("description"),
      },
      points,
    };
  } catch {
    return null;
  }
}

export function writeUnsavedListing(key: string, listing: UnsavedListing) {
  const empty =
    !listing.points.length &&
    !listing.form.name.trim() &&
    !listing.form.description.trim();
  try {
    if (empty) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(listing));
  } catch {
    // Full or blocked storage: the form still works, it just won't survive a reload.
  }
}

export function clearUnsavedListing(key: string) {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}
