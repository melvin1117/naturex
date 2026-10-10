import Image from "next/image";

export type SiteThumbnailProps = {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Data window of the composite, e.g. `{ start: "2025-10-01", end: "2026-10-01" }`. */
  dateWindow: { start: string; end: string };
  attributions: readonly string[];
};

/** Precomputed Sentinel-2 thumbnail; attribution lives in the caption, not the pixels. */
export function SiteThumbnail({
  src,
  alt,
  width,
  height,
  dateWindow,
  attributions,
}: SiteThumbnailProps) {
  return (
    <figure className="space-y-2">
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        unoptimized
        className="h-auto w-full rounded-md border"
      />
      <figcaption className="space-y-1 text-xs text-muted-foreground">
        <p>
          Sentinel-2 true colour, cloud-masked median {dateWindow.start} to{" "}
          {dateWindow.end}.
        </p>
        {attributions.map((text) => (
          <p key={text}>{text}</p>
        ))}
      </figcaption>
    </figure>
  );
}
