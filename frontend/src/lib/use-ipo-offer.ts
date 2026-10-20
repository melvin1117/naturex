import { useMemo, useState } from "react";

import type { IpoPreview } from "./api/types";
import { useIpoPreview, type QueryResult } from "./hooks";
import {
  DEFAULT_RETAINED_PCT,
  DEFAULT_TOTAL_SHARES,
  parseRetainedPct,
  parseTotalShares,
  PREVIEW_DEBOUNCE_MS,
  previewMatches,
  retainedInput,
} from "./ipo";
import { unitsInput } from "./trade";
import { useDebounced } from "./use-debounced";

export interface IpoOffer {
  /** What's in the inputs: digits only, and a percentage with at most 2 decimals. */
  sharesText: string;
  retainedText: string;
  setShares: (text: string) => void;
  setRetained: (text: string) => void;
  /** The inputs parsed, or null while they're out of range. */
  totalShares: number | null;
  retainedPct: string | null;
  preview: QueryResult<IpoPreview>;
  /** The last preview the backend answered, kept on screen (dimmed) while the next loads. */
  shown: IpoPreview | undefined;
  /** The preview for exactly the inputs on screen, settled; else undefined. */
  current: IpoPreview | undefined;
  /** `current` says the launch would go ahead, nothing is loading and no launch is running. */
  canLaunch: boolean;
}

/**
 * The opening offer an owner is shaping (T64): the two inputs, a preview asked for once both
 * have settled for `PREVIEW_DEBOUNCE_MS`, and whether what's on screen can be launched.
 * `onEdit` runs on every change to the inputs (e.g. to clear a previous launch refusal).
 */
export function useIpoOffer(
  assetId: string | undefined,
  {
    enabled = true,
    launching = false,
    onEdit,
  }: { enabled?: boolean; launching?: boolean; onEdit?: () => void } = {},
): IpoOffer {
  const [sharesText, setSharesText] = useState(String(DEFAULT_TOTAL_SHARES));
  const [retainedText, setRetainedText] = useState(
    String(DEFAULT_RETAINED_PCT),
  );
  const totalShares = parseTotalShares(sharesText);
  const retainedPct = parseRetainedPct(retainedText);

  // Both inputs settle together, so editing one then the other asks for one preview.
  const offer = useMemo(
    () => [totalShares, retainedPct] as const,
    [totalShares, retainedPct],
  );
  const [askedShares, askedRetained] = useDebounced(offer, PREVIEW_DEBOUNCE_MS);
  const preview = useIpoPreview(assetId, askedShares, askedRetained, {
    enabled,
  });

  const [shown, setShown] = useState<IpoPreview | undefined>(preview.data);
  if (preview.data && preview.data !== shown) setShown(preview.data);

  const settled =
    totalShares !== null &&
    retainedPct !== null &&
    totalShares === askedShares &&
    retainedPct === askedRetained;
  const current =
    settled &&
    preview.status === "success" &&
    preview.data &&
    previewMatches(preview.data, totalShares, retainedPct)
      ? preview.data
      : undefined;

  return {
    sharesText,
    retainedText,
    setShares: (text) => {
      setSharesText(unitsInput(text));
      onEdit?.();
    },
    setRetained: (text) => {
      setRetainedText(retainedInput(text));
      onEdit?.();
    },
    totalShares,
    retainedPct,
    preview,
    shown,
    current,
    canLaunch:
      current !== undefined &&
      current.launchable &&
      !preview.isFetching &&
      !launching,
  };
}
