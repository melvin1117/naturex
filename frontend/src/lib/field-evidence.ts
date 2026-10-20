/**
 * Field evidence (T40, dev-spec §7.6): words for the API's photo checks. Every check, label,
 * reason and number is the API's; this only says them for people.
 */
import type { ApiError } from "./api/errors";
import type {
  FieldEvidence,
  FieldPhoto,
  FieldPhotoObservation,
} from "./api/types";
import { fileSize } from "./verification";
import { withCommunity } from "./navigation";

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const PHOTO_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export const PHOTO_ACCEPT = PHOTO_MEDIA_TYPES.join(",");
/** How often the steward's list asks again while a photo is being read. */
export const EVIDENCE_POLL_MS = 3_000;

type LandCover = FieldPhotoObservation["land_cover"][number];
type Disturbance = FieldPhotoObservation["disturbance"][number];
type Concern = FieldPhotoObservation["authenticity_concerns"][number];

export const LAND_COVER_LABEL: Record<LandCover, string> = {
  tree_cover: "Tree cover",
  shrubland: "Shrubland",
  grassland: "Grassland",
  wetland_vegetation: "Wetland vegetation",
  open_water: "Open water",
  cropland: "Cropland",
  bare_ground: "Bare ground",
  built_up: "Built-up land",
};

export const DISTURBANCE_LABEL: Record<Disturbance, string> = {
  fire_scar: "Fire scar",
  clearing_or_logging: "Clearing or logging",
  dumping_or_waste: "Dumping or waste",
  construction: "Construction",
  erosion: "Erosion",
  drought_stress: "Drought stress",
};

const CONCERN_LABEL: Record<Concern, string> = {
  screen_or_print_photo: "a photo of a screen or a print",
  edited_or_composited: "edited or composited",
  watermark_or_stock: "a watermark or stock photo",
  not_a_photo: "not a photograph",
};

/** Why a photo isn't validated evidence, in the API's order. */
const REASON_TEXT: Record<string, string> = {
  gps_missing:
    "The photo has no GPS position. Turn on location for your camera and take it again.",
  gps_outside: "The photo was taken outside the listing's boundary.",
  taken_missing: "The photo has no date taken.",
  taken_future: "The photo's date is in the future.",
  taken_too_old: "The photo is more than a year old.",
  not_analysed:
    "The image model didn't read it, so it can't count as evidence.",
  not_a_landscape:
    "It doesn't look like an outdoor photo of the land, water or vegetation.",
  no_land_cover: "No land cover could be made out.",
  authenticity_concern: "It may not be an original photo.",
  instruction_text:
    "It holds text aimed at an AI model, so it was set aside (possible manipulation).",
};

export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? "It didn't pass a check.";
}

export type CheckState = "pass" | "fail" | "pending" | "skipped";

export interface PhotoCheck {
  id: "location" | "date" | "analysis";
  label: string;
  state: CheckState;
  detail: string;
}

function metres(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toFixed(1)} km`
    : `${Math.round(value)} m`;
}

function locationCheck(photo: FieldPhoto): PhotoCheck {
  const base = { id: "location", label: "Location" } as const;
  switch (photo.gps_check) {
    case "inside":
      return { ...base, state: "pass", detail: "Taken inside the listing." };
    case "near":
      return {
        ...base,
        state: "pass",
        detail: `Taken ${metres(photo.gps_distance_m ?? 0)} outside the boundary, within the ${photo.gps_buffer_m} m allowed.`,
      };
    case "outside":
      return {
        ...base,
        state: "fail",
        detail: `Taken more than ${photo.gps_buffer_m} m outside the boundary.`,
      };
    case "missing":
      return {
        ...base,
        state: "fail",
        detail: "No GPS position in the photo.",
      };
  }
}

function dateCheck(photo: FieldPhoto): PhotoCheck {
  const base = { id: "date", label: "Date taken" } as const;
  const when = photo.taken_on ? shortDate(photo.taken_on) : null;
  switch (photo.date_check) {
    case "ok":
      return { ...base, state: "pass", detail: `${when}.` };
    case "too_old":
      return {
        ...base,
        state: "fail",
        detail: `${when}: more than ${photo.max_age_days} days ago.`,
      };
    case "future":
      return { ...base, state: "fail", detail: `${when}: in the future.` };
    case "missing":
      return { ...base, state: "fail", detail: "No date in the photo." };
  }
}

function analysisCheck(photo: FieldPhoto, geotagPassed: boolean): PhotoCheck {
  const base = { id: "analysis", label: "Image analysis" } as const;
  switch (photo.analysis_status) {
    case "pending":
      return { ...base, state: "pending", detail: "Reading the photo…" };
    case "failed":
      return {
        ...base,
        state: "fail",
        detail:
          "No answer from the image model. Delete the photo and upload it again later.",
      };
    case "not_run":
      return {
        ...base,
        state: "skipped",
        detail: geotagPassed
          ? "Not run: AI analysis is off for now, so the photo can't count as evidence."
          : "Not run: the location and date must pass first.",
      };
    case "completed":
      return {
        ...base,
        state: photo.validated ? "pass" : "fail",
        detail: observationSummary(photo.observation),
      };
  }
}

export function photoChecks(photo: FieldPhoto): PhotoCheck[] {
  const location = locationCheck(photo);
  const date = dateCheck(photo);
  const passed = location.state === "pass" && date.state === "pass";
  return [location, date, analysisCheck(photo, passed)];
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function observationSummary(
  observation: FieldPhotoObservation | null | undefined,
): string {
  if (!observation) return "No labels.";
  const parts: string[] = [];
  if (observation.land_cover.length > 0)
    parts.push(
      `Shows ${list(observation.land_cover.map((c) => LAND_COVER_LABEL[c].toLowerCase()))}.`,
    );
  parts.push(
    observation.disturbance.length > 0
      ? `Signs of ${list(observation.disturbance.map((d) => DISTURBANCE_LABEL[d].toLowerCase()))}.`
      : "No signs of disturbance.",
  );
  if (observation.authenticity_concerns.length > 0)
    parts.push(
      `Possibly ${list(observation.authenticity_concerns.map((c) => CONCERN_LABEL[c]))}.`,
    );
  return parts.join(" ");
}

export type PhotoVerdict = "validated" | "checking" | "not_counted";

export function photoVerdict(photo: FieldPhoto): PhotoVerdict {
  if (photo.validated) return "validated";
  if (photo.analysis_status === "pending") return "checking";
  return "not_counted";
}

export const VERDICT_LABEL: Record<PhotoVerdict, string> = {
  validated: "Counts as evidence",
  checking: "Checking",
  not_counted: "Doesn't count",
};

export function isPending(evidence: FieldEvidence | undefined): boolean {
  return (
    evidence?.photos.some((photo) => photo.analysis_status === "pending") ??
    false
  );
}

export interface ConfidenceStory {
  title: string;
  body: string;
}

/** What the evidence does to the listing's confidence, from the API's deterministic effect. */
export function confidenceStory(evidence: FieldEvidence): ConfidenceStory {
  const { confidence, validated } = evidence;
  const points = Number(confidence.points);
  if (confidence.counted)
    return {
      title: "Counted in the latest rating",
      body: `The latest rating already used your validated photos: ${pct(confidence.current)} confidence.`,
    };
  if (validated === 0)
    return {
      title: "No validated photo yet",
      body: "A validated photo raises the rating's confidence by a fixed amount: the evidence term of the confidence formula goes from 0.3 to 1.0.",
    };
  if (confidence.current == null || confidence.projected == null)
    return {
      title: `+${points.toFixed(0)} points at the first rating`,
      body: `Validated field evidence raises the rating's confidence by ${points.toFixed(0)} points once the listing is rated.`,
    };
  if (!reachesListing(evidence))
    return {
      title: `${pct(confidence.current)} → ${pct(confidence.projected)} at the next rating`,
      body: `Validated field evidence adds ${points.toFixed(0)} points of confidence, but a listing needs at least ${pct(confidence.listing_min)} to list, so it would still need more evidence. Newer satellite data can raise it further, or you can revise the listing.`,
    };
  return {
    title: `${pct(confidence.current)} → ${pct(confidence.projected)} at the next rating`,
    body: `Validated field evidence adds ${points.toFixed(0)} points of confidence, by the fixed formula; the AI never sets the number. It counts when the listing is rated again.`,
  };
}

/** Whether the next rating's projected confidence reaches the listing gate's minimum. */
export function reachesListing(evidence: FieldEvidence): boolean {
  const { projected, listing_min } = evidence.confidence;
  return projected != null && Number(projected) >= Number(listing_min);
}

/** "Oct 2026" for the API's `YYYY-MM`: the public sees the month of a visit, never the day. */
export function monthYear(month: string): string {
  return new Date(`${month.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString(
    "en-GB",
    { month: "short", year: "numeric", timeZone: "UTC" },
  );
}

function pct(value: string | null | undefined): string {
  return value == null ? "—" : `${Number(value).toFixed(1)}%`;
}

export function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function photoFileProblem(
  file: Pick<File, "size" | "type"> | null,
): string | null {
  if (!file) return "Choose a photo to upload.";
  if (!(PHOTO_MEDIA_TYPES as readonly string[]).includes(file.type))
    return "Choose a JPEG or PNG photo.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_PHOTO_BYTES)
    return `That photo is ${fileSize(file.size)}; the limit is 10 MB.`;
  return null;
}

export function photoUploadFailure(error: ApiError): string {
  switch (error.code) {
    case "file_too_large":
      return "That photo is over 10 MB. Upload a smaller one.";
    case "unsupported_media_type":
    case "unsupported_format":
    case "media_type_mismatch":
      return "Only JPEG and PNG photos are accepted, and the file's contents must match its type.";
    case "empty_file":
      return "That file is empty.";
    case "image_too_large":
      return "That image is too large to inspect (at most 40 megapixels and 12,000 px a side).";
    case "image_malformed":
      return "That photo couldn't be read. Export it again as JPEG.";
    case "trailing_data":
    case "embedded_signature":
      return "That file carries extra hidden data, so it can't be accepted. Export it again.";
    case "photo_limit_reached":
      return "This listing already has 5 photos. Delete one to add another.";
    case "photo_duplicate":
      return "That photo is already uploaded.";
    case "listing_closed":
      return "This listing is withdrawn or not eligible, so it doesn't take photos.";
    case "upload_rate_limited":
      return "Too many uploads in the last hour. Try again later.";
    case "inspection_busy":
    case "inspection_timeout":
    case "inspection_failed":
      return "We couldn't check the photo just now. Try again in a minute.";
    default:
      return error.message;
  }
}

/** The steward's field evidence screen for a listing. */
export function evidenceHref(
  assetId: string,
  communityId: string | null,
): string {
  return withCommunity(`/steward/assets/${assetId}/evidence`, communityId);
}
