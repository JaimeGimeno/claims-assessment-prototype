import { useMemo, useState } from "react";
import { api } from "../api";
import type { ClaimView, EstimateLine, Finding, FindingPatch } from "../api";
import { useApp } from "../app-context";
import { cap, money2 } from "../format";
import { Button, cx, ErrorNote, Field, inputClass } from "../ui";

const SIDES = ["left", "right", "center", "unknown"];

export function ReasonPicker({ value, onChange, label = "Reason for the change" }: { value: string; onChange: (id: string) => void; label?: string }) {
  const { reference } = useApp();
  return (
    <fieldset>
      <legend className="mb-1 text-[13px] font-medium">
        {label} <span className="font-normal text-muted">(required)</span>
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {reference.edit_reasons.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={value === r.id}
            onClick={() => onChange(r.id)}
            className={cx(
              "h-7 rounded-md border px-2.5 text-[13px] transition-colors",
              value === r.id ? "border-ink bg-ink font-medium text-white" : "border-line-strong bg-surface text-ink hover:border-faint hover:bg-subtle",
            )}
          >
            {r.name}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

interface Props {
  claimId: string;
  /** The finding being edited; leave out to add a new one. */
  finding?: Finding;
  line?: EstimateLine;
  photoId?: string | null;
  photoLabel?: string;
  onDone: (view: ClaimView) => void;
  onCancel: () => void;
}

export default function FindingForm({ claimId, finding, line, photoId, photoLabel, onDone, onCancel }: Props) {
  const { reference } = useApp();
  const adding = !finding;
  const [part, setPart] = useState(finding?.part ?? "");
  const [side, setSide] = useState(finding?.side || "unknown");
  const [damageType, setDamageType] = useState(finding?.damage_type ?? "");
  const [severity, setSeverity] = useState<string>(finding?.severity ?? "");
  const [operation, setOperation] = useState(finding?.operation_override ?? "");
  const startPrice = finding?.price_override != null ? String(finding.price_override) : "";
  const [price, setPrice] = useState(startPrice);
  const [picked, setPicked] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changes = useMemo(() => {
    const out: Partial<FindingPatch> = {};
    if (!finding) return out;
    if (part !== finding.part) out.part = part;
    if (side !== (finding.side || "unknown")) out.side = side;
    if (damageType !== finding.damage_type) out.damage_type = damageType;
    if (severity !== finding.severity) out.severity = severity;
    if (operation !== (finding.operation_override ?? "")) out.operation_override = operation;
    if (price.trim() !== startPrice && price.trim() !== "" && !Number.isNaN(Number(price))) out.price_override = Number(price);
    return out;
  }, [finding, part, side, damageType, severity, operation, price, startPrice]);

  // The most likely reason is preselected from what was changed; one click changes it.
  const suggested = adding
    ? "missed_damage"
    : changes.part !== undefined
      ? "wrong_part"
      : changes.damage_type !== undefined
        ? "wrong_damage_type"
        : changes.severity !== undefined
          ? "wrong_severity"
          : changes.operation_override !== undefined
            ? "repair_vs_replace"
            : changes.price_override !== undefined
              ? "price_adjustment"
              : "";
  const reason = picked || suggested;
  const priceInvalid = price.trim() !== "" && (Number.isNaN(Number(price)) || Number(price) < 0 || Number(price) > 100000);
  const hasChange = adding ? Boolean(part && damageType && severity) : Object.keys(changes).length > 0;
  const canSave = hasChange && Boolean(reason) && !priceInvalid;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = adding
        ? await api.addFinding(claimId, { part, side, damage_type: damageType, severity, photo_id: photoId ?? undefined, reason_code: reason, note })
        : await api.editFinding(claimId, finding.id, { ...changes, reason_code: reason, note });
      onDone(view);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
      className="space-y-3 border-y border-line bg-subtle px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold">{adding ? "Add damage" : `Edit ${finding.part_name.toLowerCase()}`}</h3>
        {adding && photoLabel ? <span className="text-xs text-muted">Linked to {photoLabel}</span> : null}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 xl:grid-cols-4">
        <Field label="Part">
          <select value={part} onChange={(e) => setPart(e.target.value)} className={inputClass} required autoFocus>
            {adding ? <option value="">Choose a part</option> : null}
            {reference.parts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Side">
          <select value={side} onChange={(e) => setSide(e.target.value)} className={inputClass}>
            {SIDES.map((s) => (
              <option key={s} value={s}>
                {cap(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Damage type">
          <select value={damageType} onChange={(e) => setDamageType(e.target.value)} className={inputClass} required>
            {adding ? <option value="">Choose a type</option> : null}
            {reference.damage_types.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Severity">
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={inputClass} required>
            {adding ? <option value="">Choose a severity</option> : null}
            {reference.severities.map((s) => (
              <option key={s.id} value={s.id} title={s.meaning}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {!adding ? (
          <>
            <Field label="Operation" className="xl:col-span-2" hint="Normally picked by the pricing rules from the damage.">
              <select value={operation} onChange={(e) => setOperation(e.target.value)} className={inputClass}>
                <option value="">Set by the rules{line && !finding.operation_override ? ` (${line.operation === "pdr" ? "paintless dent repair" : line.operation})` : ""}</option>
                {reference.operations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Line price, $"
              className="xl:col-span-2"
              hint={
                priceInvalid ? (
                  <span className="text-bad">Enter an amount between 0 and 100,000.</span>
                ) : startPrice ? (
                  "Set by an adjuster. It can be changed, but not cleared, in this prototype."
                ) : (
                  `Leave empty to keep the calculated price${line ? ` (${money2(line.total)})` : ""}.`
                )
              }
            >
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder={line ? line.total.toFixed(2) : "Calculated"}
                className={cx(inputClass, "num")}
                aria-invalid={priceInvalid}
              />
            </Field>
          </>
        ) : null}
      </div>
      {severity ? <p className="text-xs text-muted">{reference.severities.find((s) => s.id === severity)?.meaning}</p> : null}
      <ReasonPicker value={reason} onChange={setPicked} label={adding ? "Reason for adding it" : "Reason for the change"} />
      <Field label="Note (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={inputClass} placeholder="Anything the next reviewer should know" />
      </Field>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!canSave}>
          {adding ? "Add to estimate" : "Save change"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {!hasChange && !adding ? <span className="text-xs text-muted">Nothing changed yet.</span> : null}
        {hasChange && !reason ? <span className="text-xs text-muted">Pick a reason to save.</span> : null}
      </div>
    </form>
  );
}
