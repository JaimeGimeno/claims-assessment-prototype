import { useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import type { PhotoItem } from "../api";
import { Chip, cx, Modal } from "../ui";

interface Props {
  photos: PhotoItem[];
  current: string | null;
  onSelect: (id: string) => void;
  counts: Record<string, number>;
  caption?: string | null;
}

export default function PhotoViewer({ photos, current, onSelect, counts, caption }: Props) {
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  if (photos.length === 0) {
    return <div className="rounded-lg border border-line bg-surface px-4 py-12 text-center text-[13px] text-muted">This claim has no photos.</div>;
  }
  const index = Math.max(0, photos.findIndex((p) => p.id === current));
  const photo = photos[index];
  const step = (d: number) => onSelect(photos[(index + d + photos.length) % photos.length].id);

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="relative flex items-center justify-center overflow-hidden rounded-t-lg bg-[#ecebe6]" style={{ height: "min(56vh, 520px)" }}>
        {failed[photo.id] ? (
          <span className="text-[13px] text-muted">This photo couldn't be loaded.</span>
        ) : (
          <button type="button" onClick={() => setZoom(true)} className="h-full w-full cursor-zoom-in" aria-label="Open the photo at full size">
            <img
              key={photo.id}
              src={`${photo.url}?w=1200`}
              alt={photo.view ? `Photo ${index + 1}: ${photo.view}` : `Photo ${index + 1}`}
              onError={() => setFailed((f) => ({ ...f, [photo.id]: true }))}
              className={cx("h-full w-full object-contain", !photo.usable && "opacity-60")}
            />
          </button>
        )}
        {!photo.usable ? (
          <div className="absolute top-2 left-2 max-w-[85%] rounded-md bg-surface px-2.5 py-1.5 text-[13px] shadow-[0_1px_4px_rgb(27_27_25/0.15)]">
            <span className="font-medium text-bad">Not usable:</span> {photo.issue_text || "the AI couldn't assess this photo"}
          </div>
        ) : null}
        <span className="pointer-events-none absolute right-2 bottom-2 rounded-sm bg-surface/90 p-1 text-muted">
          <Maximize2 size={13} aria-hidden />
        </span>
        {photos.length > 1 ? (
          <>
            <button type="button" onClick={() => step(-1)} aria-label="Previous photo" className="absolute top-1/2 left-2 -translate-y-1/2 rounded-md bg-surface/90 p-1.5 text-ink hover:bg-surface">
              <ChevronLeft size={16} />
            </button>
            <button type="button" onClick={() => step(1)} aria-label="Next photo" className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md bg-surface/90 p-1.5 text-ink hover:bg-surface">
              <ChevronRight size={16} />
            </button>
          </>
        ) : null}
      </div>

      <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-3 py-2 text-[13px]">
        <span className="num font-medium">
          Photo {index + 1} of {photos.length}
        </span>
        {photo.view ? <span className="text-muted">{photo.view}</span> : null}
        {photo.runs_disagree ? <Chip tone="warn" title="One of the two AI runs judged this photo unusable">Runs disagree on quality</Chip> : null}
        {caption ? <span className="ml-auto text-muted">Showing: {caption}</span> : null}
      </div>

      {photos.length > 1 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-line p-2">
          {photos.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              aria-label={`Photo ${i + 1}${p.usable ? "" : ", not usable"}`}
              aria-pressed={p.id === photo.id}
              title={p.usable ? p.view : p.issue_text || "Not usable"}
              className={cx(
                "relative h-14 w-[72px] overflow-hidden rounded-sm border bg-subtle",
                p.id === photo.id ? "border-ink outline-1 outline-ink" : "border-line hover:border-faint",
              )}
            >
              <img src={`${p.url}?w=160`} alt="" loading="lazy" className={cx("h-full w-full object-cover", !p.usable && "opacity-40")} />
              {!p.usable ? <span className="absolute inset-x-0 bottom-0 bg-bad px-1 text-center text-[10px] leading-4 font-medium text-white">Not usable</span> : null}
              {p.usable && counts[p.id] ? (
                <span className="num absolute top-0.5 right-0.5 rounded-sm bg-ink px-1 text-[10px] leading-4 font-medium text-white" title={`${counts[p.id]} findings point at this photo`}>
                  {counts[p.id]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <Modal open={zoom} onClose={() => setZoom(false)} title={`Photo ${index + 1} of ${photos.length}${photo.view ? ` · ${photo.view}` : ""}`} width={1200}>
        <img src={photo.url} alt="" className="mx-auto max-h-[76vh] w-auto max-w-full object-contain" />
      </Modal>
    </div>
  );
}
