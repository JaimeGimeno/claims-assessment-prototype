import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Check, FileImage, Upload, X } from "lucide-react";
import { api } from "../api";
import type { ApiError, Sample } from "../api";
import { useApp } from "../app-context";
import { money } from "../format";
import { Button, Card, CardHeader, cx, Empty, ErrorNote, Field, inputClass, LoadingBlock, PageHeader, SampleTag, Toggle, useElapsed, useLoad } from "../ui";

type Tier = "all" | "human" | "ai" | "dev";

const TIERS: { id: Tier; label: string; about: string }[] = [
  { id: "all", label: "All", about: "Every sample photo." },
  { id: "human", label: "Human-checked", about: "A person checked the labels. These photos are the ones the evaluation scores." },
  { id: "ai", label: "AI-labelled", about: "Labels drafted by AI and not checked by a person. Some have no labels yet." },
  { id: "dev", label: "Used to write the prompt", about: "The AI's instructions were written with these in view, so they are not a fair test." },
];

const ACCEPT = ".jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif";
const OK_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

interface Upl {
  key: string;
  file: File;
  preview: string | null;
}

export default function TryIt() {
  const { reference, refreshUsage, usage } = useApp();
  const nav = useNavigate();
  const samples = useLoad<Sample[]>(api.samples, []);
  const max = reference.limits.max_photos;
  const maxMb = reference.limits.max_upload_mb;

  const [tier, setTier] = useState<Tier>("all");
  const [picked, setPicked] = useState<string[]>([]);
  const [uploads, setUploads] = useState<Upl[]>([]);
  const [dragging, setDragging] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const midPreset = reference.vehicle_presets.find((p) => p.vehicle_class === "midsize_standard") ?? reference.vehicle_presets[0];
  // "auto": the visitor fills in nothing and the AI works out the type of car.
  const [preset, setPreset] = useState<string>(midPreset ? "auto" : "custom");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [vclass, setVclass] = useState("midsize_standard");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [drivable, setDrivable] = useState(true);
  const [airbags, setAirbags] = useState(false);
  const [wantLive, setWantLive] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const elapsed = useElapsed(busy);

  useEffect(
    () => () => {
      uploads.forEach((u) => u.preview && URL.revokeObjectURL(u.preview));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const total = picked.length + uploads.length;
  const room = max - total;
  const byId = useMemo(() => new Map((samples.data ?? []).map((s) => [s.id, s])), [samples.data]);
  const shown = useMemo(() => (samples.data ?? []).filter((s) => tier === "all" || s.tier === tier), [samples.data, tier]);
  const tierCount = (t: Tier) => (samples.data ?? []).filter((s) => t === "all" || s.tier === t).length;
  const anyStored = (samples.data ?? []).some((s) => s.stored_result);
  const allStored = (samples.data ?? []).length > 0 && (samples.data ?? []).every((s) => s.stored_result);

  const toggle = (id: string) => {
    setError(null);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length + uploads.length >= max ? p : [...p, id]));
  };

  const addFiles = (list: FileList | File[]) => {
    const notes: string[] = [];
    const next: Upl[] = [];
    let left = max - picked.length - uploads.length;
    for (const f of Array.from(list)) {
      if (!OK_EXT.test(f.name) && !/^image\/(jpeg|png|webp|heic|heif)$/.test(f.type)) {
        notes.push(`${f.name}: only JPG, PNG, WebP and HEIC photos can be used.`);
        continue;
      }
      if (f.size > maxMb * 1024 * 1024) {
        notes.push(`${f.name}: larger than ${maxMb} MB.`);
        continue;
      }
      if (left <= 0) {
        notes.push(`${f.name}: a claim can have at most ${max} photos.`);
        continue;
      }
      left -= 1;
      const canPreview = /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
      next.push({ key: `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(36).slice(2, 7)}`, file: f, preview: canPreview ? URL.createObjectURL(f) : null });
    }
    setFileNote(notes.length ? notes.join(" ") : null);
    if (next.length) setUploads((u) => [...u, ...next]);
    setError(null);
  };

  const removeUpload = (key: string) =>
    setUploads((u) => {
      const gone = u.find((x) => x.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return u.filter((x) => x.key !== key);
    });

  const single = picked.length === 1 && uploads.length === 0 ? byId.get(picked[0]) : undefined;
  const forcedWhy = uploads.length
    ? "an uploaded photo has no stored result"
    : picked.length > 1
      ? "stored results exist only for single sample photos"
      : description.trim()
        ? "the description changes what the AI is asked"
        : preset !== "auto"
          ? "the AI has to compare the photos with the car you chose"
        : single && !single.stored_result
          ? "this sample photo has no stored result"
          : null;
  const live = total > 0 && (forcedWhy !== null || wantLive);
  const atCap = usage ? usage.live_runs_today >= usage.daily_cap : false;

  const custom = preset === "custom";
  const valueNum = Number(value);
  const customOk = !custom || (vclass !== "" && value.trim() !== "" && valueNum >= 500 && valueNum <= 500000 && (year.trim() === "" || /^\d{4}$/.test(year.trim())));
  const canSubmit = total > 0 && customOk && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("photo_ids", picked.join(","));
    uploads.forEach((u) => form.append("files", u.file, u.file.name));
    if (custom) {
      form.set("make", make);
      form.set("model", model);
      form.set("year", year.trim());
      form.set("vehicle_class", vclass);
      form.set("value", value.trim());
    } else {
      form.set("preset_id", preset);
    }
    form.set("description", description);
    form.set("drivable", drivable ? "true" : "false");
    form.set("airbags", airbags ? "true" : "false");
    form.set("run_live", live ? "true" : "false");
    try {
      const { id } = await api.tryIt(form);
      refreshUsage();
      nav(`/claims/${id}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
      refreshUsage();
    }
  };

  return (
    <div className="mx-auto max-w-[1560px] px-6 py-5">
      <PageHeader
        title="Try it"
        sub={`Build a claim from sample photos or your own, up to ${max} photos, and see what the AI and the routing rules make of it.`}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Sample photos" sub={samples.data ? `${samples.data.length} photos` : undefined} aside={<span className="num text-[13px] text-muted">{total} of {max} photos chosen</span>} />
            <div className="border-b border-line px-3 py-2">
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter sample photos">
                {TIERS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tier === t.id}
                    onClick={() => setTier(t.id)}
                    className={cx(
                      "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                      tier === t.id ? "bg-ink text-white" : "text-muted hover:bg-ink/5 hover:text-ink",
                    )}
                  >
                    {t.label}
                    <span className={cx("num text-xs", tier === t.id ? "text-white/70" : "text-faint")}>{tierCount(t.id)}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 px-0.5 text-xs text-muted">
                {TIERS.find((t) => t.id === tier)?.about}
                {allStored ? " Picked alone, a sample photo opens instantly from its stored AI result." : anyStored ? " Photos marked Instant have a stored AI result." : ""}
              </p>
            </div>
            {samples.loading && !samples.data ? <LoadingBlock label="Loading sample photos" /> : null}
            {samples.error ? <ErrorNote className="m-3" onRetry={samples.reload}>{samples.error}</ErrorNote> : null}
            {samples.data && shown.length === 0 ? <Empty title="No sample photos in this group" /> : null}
            {shown.length ? (
              <div className="grid max-h-[calc(100vh-290px)] min-h-[320px] grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2 overflow-y-auto p-3">
                {shown.map((s) => {
                  const on = picked.includes(s.id);
                  const full = !on && room <= 0;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={on}
                      disabled={full}
                      onClick={() => toggle(s.id)}
                      title={full ? `A claim can have at most ${max} photos` : s.id}
                      className={cx(
                        "group relative aspect-[4/3] overflow-hidden rounded-md border bg-subtle",
                        on ? "border-accent outline-2 outline-accent" : "border-line hover:border-faint",
                        full && "opacity-40",
                      )}
                    >
                      <img src={`/photos/${s.id}?w=240`} alt={`Sample photo ${s.id}`} loading="lazy" className="h-full w-full object-cover" />
                      {on ? (
                        <span className="absolute top-1 left-1 flex h-5 w-5 items-center justify-center rounded-sm bg-accent text-white">
                          <Check size={13} strokeWidth={3} />
                        </span>
                      ) : null}
                      {s.stored_result && !allStored ? (
                        <span className="absolute right-1 bottom-1 rounded-sm bg-surface/95 px-1 text-[10px] leading-4 font-medium text-ok" title="Has a stored AI result, so it opens instantly and costs nothing">
                          Instant
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </Card>
        </div>

        <form
          className="space-y-4 lg:sticky lg:top-16"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <Card>
            <CardHeader title="Your photos" />
            <div className="space-y-3 p-3">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
                }}
                className={cx("rounded-md border border-dashed px-3 py-4 text-center transition-colors", dragging ? "border-accent bg-accent-soft" : "border-line-strong bg-subtle")}
              >
                <Upload size={18} className="mx-auto text-muted" aria-hidden />
                <p className="mt-1.5 text-[13px]">
                  Drop photos here or{" "}
                  <button type="button" onClick={() => fileInput.current?.click()} className="font-medium text-accent underline underline-offset-2" disabled={room <= 0}>
                    choose files
                  </button>
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  JPG, PNG, WebP or HEIC, up to {maxMb} MB each.
                </p>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPT}
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              <p className="text-xs text-muted">Uploaded photos are stored on this demo server.</p>
              {fileNote ? <ErrorNote>{fileNote}</ErrorNote> : null}

              {total > 0 ? (
                <ul className="grid grid-cols-3 gap-2">
                  {picked.map((id) => (
                    <li key={id} className="relative">
                      <img src={`/photos/${id}?w=240`} alt={`Sample ${id}`} className="aspect-[4/3] w-full rounded-sm border border-line object-cover" />
                      <RemoveButton label={`Remove sample ${id}`} onClick={() => toggle(id)} />
                    </li>
                  ))}
                  {uploads.map((u) => (
                    <li key={u.key} className="relative">
                      {u.preview ? (
                        <img src={u.preview} alt={u.file.name} className="aspect-[4/3] w-full rounded-sm border border-line object-cover" />
                      ) : (
                        <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-sm border border-line bg-subtle px-1.5 text-center" title="This browser can't preview this file type. It will still be uploaded.">
                          <FileImage size={16} className="text-muted" aria-hidden />
                          <span className="w-full truncate text-[11px] text-muted">{u.file.name}</span>
                        </div>
                      )}
                      <RemoveButton label={`Remove ${u.file.name}`} onClick={() => removeUpload(u.key)} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">No photos chosen yet. Pick sample photos on the left, or upload your own.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Car and accident" aside={<SampleTag>Sample values</SampleTag>} />
            <div className="space-y-3 p-3">
              <Field label="Car">
                <select value={preset} onChange={(e) => setPreset(e.target.value)} className={inputClass}>
                  <option value="auto">Let the AI draft the policy car</option>
                  {reference.vehicle_presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.year} {p.make} {p.model} · {money(p.value)}
                    </option>
                  ))}
                  <option value="custom">Another car…</option>
                </select>
              </Field>
              {preset === "auto" ? (
                <p className="text-xs text-muted">
                  Nothing to fill in. A real claim always has a policy behind it, so for a try-out the AI drafts one from the photos: make, model, year and class, with a sample value. Pick a car yourself to see the photos checked against it.
                </p>
              ) : null}
              {custom ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  <Field label="Make">
                    <input value={make} onChange={(e) => setMake(e.target.value)} maxLength={40} className={inputClass} placeholder="Mazda" />
                  </Field>
                  <Field label="Model">
                    <input value={model} onChange={(e) => setModel(e.target.value)} maxLength={40} className={inputClass} placeholder="CX-5" />
                  </Field>
                  <Field label="Year">
                    <input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" maxLength={4} className={cx(inputClass, "num")} placeholder="2018" />
                  </Field>
                  <Field label="Value, $" hint="Between 500 and 500,000.">
                    <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" className={cx(inputClass, "num")} placeholder="18000" required />
                  </Field>
                  <Field label="Class" className="col-span-2" hint="Sets which row of the price table is used.">
                    <select value={vclass} onChange={(e) => setVclass(e.target.value)} className={inputClass}>
                      {reference.vehicle_classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : null}
              <Field label="Accident description (optional)" hint="The AI checks whether the damage fits it.">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  maxLength={600}
                  className={cx(inputClass, "h-auto py-2 leading-normal")}
                  placeholder="Reversed into a post in a car park. Rear bumper hit on the left."
                />
              </Field>
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <span>The car is drivable</span>
                <Toggle checked={drivable} onChange={setDrivable} label="The car is drivable" />
              </div>
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <span>The airbags deployed</span>
                <Toggle checked={airbags} onChange={setAirbags} label="The airbags deployed" />
              </div>
            </div>
          </Card>

          <Card className="space-y-3 p-3">
            <label className="flex items-start gap-2.5 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[#1b1b19]"
                checked={live}
                disabled={total === 0 || forcedWhy !== null}
                onChange={(e) => setWantLive(e.target.checked)}
              />
              <span>
                <span className="font-medium">Run the AI live</span>
                <span className="block text-xs text-muted">
                  {total === 0
                    ? "Choose a photo first."
                    : forcedWhy
                      ? `Always on here: ${forcedWhy}. Takes 5 to 20 seconds and costs a few cents.`
                      : live
                        ? "Takes 5 to 20 seconds and costs a few cents."
                        : "Off: this sample photo opens instantly from its stored result."}
                </span>
              </span>
            </label>
            {!anyStored && samples.data ? <p className="text-xs text-muted">No sample photo has a stored result on this server yet, so every run here is live.</p> : null}
            {live && atCap ? <ErrorNote>Today's limit of live AI runs has been reached. Sample photos with a stored result still work.</ErrorNote> : null}
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            {busy ? (
              <div role="status" className="space-y-1.5">
                <div className="h-1 overflow-hidden rounded-full bg-line">
                  <div className="h-1 rounded-full bg-ink transition-[width] duration-1000 ease-linear" style={{ width: `${Math.min(95, live ? (elapsed / 20) * 100 : 60)}%` }} />
                </div>
                <p className="num text-xs text-muted">
                  {live ? `${uploads.length ? "Uploading, then the AI reads the photos" : "The AI is reading the photos"}. ${elapsed} s` : "Opening the stored result."}
                </p>
              </div>
            ) : null}
            <Button type="submit" variant="primary" className="w-full" busy={busy} disabled={!canSubmit}>
              {busy ? "Working" : live || total === 0 ? "Assess this claim" : "Open the stored result"}
            </Button>
            {custom && !customOk ? <p className="text-xs text-muted">Enter the car's value (and a four-digit year, if any) to continue.</p> : null}
          </Card>
        </form>
      </div>
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-sm bg-ink/80 text-white hover:bg-ink">
      <X size={12} strokeWidth={3} />
    </button>
  );
}
