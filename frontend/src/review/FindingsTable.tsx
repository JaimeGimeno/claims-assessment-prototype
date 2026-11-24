import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import type { ClaimView, EstimateLine, Finding } from "../api";
import { useApp } from "../app-context";
import { AGREEMENT_TEXT, cap, hours, money2, range } from "../format";
import { Button, Card, CardHeader, Chip, ConfidenceChip, cx, Empty, ErrorNote, Field, inputClass, SampleTag } from "../ui";
import FindingForm, { ReasonPicker } from "./FindingForm";

const OP_NAMES: Record<string, string> = { pdr: "Paintless dent repair" };

function RemovePanel({ claimId, finding, onDone, onCancel }: { claimId: string; finding: Finding; onDone: (v: ClaimView) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.removeFinding(claimId, finding.id, reason, note));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 border-y border-line bg-subtle px-4 py-3">
      <h3 className="text-[13px] font-semibold">Remove {finding.part_name.toLowerCase()} from the estimate</h3>
      <ReasonPicker value={reason} onChange={setReason} label="Reason for removing it" />
      <Field label="Note (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={inputClass} />
      </Field>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="danger" busy={busy} disabled={!reason} onClick={remove}>
          Remove
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {!reason ? <span className="text-xs text-muted">Pick a reason to remove it.</span> : null}
      </div>
    </div>
  );
}

interface Props {
  view: ClaimView;
  selected: string | null;
  onSelect: (f: Finding) => void;
  onChange: (v: ClaimView) => void;
  currentPhoto: string | null;
  locked: boolean;
  /** why the estimate can't be changed right now */
  lockedText?: string;
}

export default function FindingsTable({ view, selected, onSelect, onChange, currentPhoto, locked, lockedText }: Props) {
  const { name } = useApp();
  const [mode, setMode] = useState<{ kind: "edit" | "remove"; id: string } | { kind: "add" } | null>(null);
  const lines = new Map<string, EstimateLine>(view.estimate.lines.map((l) => [l.finding_id, l]));
  const photoIndex = (id?: string) => (id ? view.photo_list.findIndex((p) => p.id === id) : -1);
  const done = (v: ClaimView) => {
    setMode(null);
    onChange(v);
  };
  const cell = "px-2.5 py-2.5 align-top";
  const numCell = "num px-2.5 py-2.5 text-right align-top whitespace-nowrap";
  const head = "px-2.5 py-2 text-xs font-medium whitespace-nowrap text-muted";
  const wide = "hidden xl:table-cell";

  return (
    <Card>
      <CardHeader
        title="Damage and estimate lines"
        sub={`${view.findings.length} ${view.findings.length === 1 ? "part" : "parts"}`}
        aside={
          <>
            <SampleTag>Sample prices and hours</SampleTag>
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setMode({ kind: "add" })} disabled={locked || mode?.kind === "add"}>
              Add damage
            </Button>
          </>
        }
      />
      {view.findings.length === 0 && mode?.kind !== "add" ? (
        <Empty title="No damage on this estimate">
          {view.assessment_failed
            ? "The AI assessment failed. Add each damaged part by hand to build the estimate."
            : view.photo_list.length > 0 && view.photo_list.every((p) => !p.usable)
              ? "No photo could be assessed, so there is nothing to price yet. Ask for better photos, or add damage by hand."
              : "The AI found no damage in the photos. If you can see damage, add it by hand."}
        </Empty>
      ) : null}
      {view.findings.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-subtle">
                <th className={cx(head, "pl-4 text-left")}>Damage and the AI's reason</th>
                <th className={cx(head, "text-left")}>Operation</th>
                <th className={cx(head, wide, "text-right")}>Part</th>
                <th className={cx(head, wide, "text-right")} title="Labour hours">
                  Labour h
                </th>
                <th className={cx(head, wide, "text-right")} title="Paint hours">
                  Paint h
                </th>
                <th className={cx(head, "text-right")}>Line total</th>
                <th className={cx(head, "pr-3 text-right")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            {view.findings.map((f) => {
              const line = lines.get(f.id);
              const isSel = selected === f.id;
              const pi = photoIndex(f.photo_id);
              const open = mode && mode.kind !== "add" && mode.id === f.id ? mode.kind : null;
              const agreement = f.source === "adjuster" ? "" : f.edited ? "Checked by you" : (AGREEMENT_TEXT[f.agreement ?? ""] ?? "");
              return (
                <tbody key={f.id} className={cx("border-b border-line last:border-0", isSel ? "bg-accent-soft/60" : "hover:bg-subtle")}>
                  <tr onClick={() => onSelect(f)} aria-selected={isSel} className="cursor-pointer">
                    <td className={cx(cell, "pb-1 pl-4")}>
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <button type="button" onClick={() => onSelect(f)} className="text-left font-semibold hover:underline">
                          {f.part_name}
                          {f.side === "left" || f.side === "right" || f.side === "center" ? <span className="font-normal text-muted">, {f.side}</span> : null}
                        </button>
                        {f.edited ? <Chip tone="accent">Edited</Chip> : null}
                        {f.source === "adjuster" ? <Chip tone="accent">Added by you</Chip> : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span>{name("damage_types", f.damage_type)}</span>
                        <span className="text-faint">·</span>
                        <span className={cx(f.severity === "severe" && "font-medium text-bad")}>
                          {cap(f.severity)}
                          {f.severity_alt && f.severity_alt !== f.severity ? <span className="font-normal text-muted"> or {f.severity_alt}</span> : null}
                        </span>
                        <ConfidenceChip level={f.confidence} title={`Confidence: ${f.confidence}. ${agreement}`} />
                      </div>
                    </td>
                    <td className={cx(cell, "pb-1")}>
                      {line ? (
                        <>
                          {OP_NAMES[line.operation] ?? cap(line.operation)}
                          {f.operation_override ? <div className="text-xs text-muted">Set by adjuster</div> : null}
                        </>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className={cx(numCell, wide, "pb-1")}>{line && line.part_price ? money2(line.part_price) : "–"}</td>
                    <td className={cx(numCell, wide, "pb-1")}>
                      {line ? hours(line.labour_hours) : "–"}
                      {line && line.labour_hours && line.labour_type !== "body" ? <div className="text-xs text-muted">{line.labour_type}</div> : null}
                    </td>
                    <td className={cx(numCell, wide, "pb-1")}>{line ? hours(line.paint_hours) : "–"}</td>
                    <td className={cx(numCell, "pb-1 font-medium")}>
                      {line ? (line.is_range ? range(line.low, line.high, money2) : money2(line.total)) : "–"}
                      {line?.is_range ? <div className="text-xs font-normal text-muted">Most likely {money2(line.total)}</div> : null}
                      {line?.price_overridden ? <div className="text-xs font-normal text-muted">Price set by adjuster</div> : null}
                    </td>
                    <td className={cx(cell, "pr-3 pb-1 pl-0 text-right whitespace-nowrap")}>
                      <button
                        type="button"
                        aria-label={`Edit ${f.part_name}`}
                        title={locked ? (lockedText ?? "Reopen the claim to change the estimate") : "Edit"}
                        disabled={locked}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(f);
                          setMode(open === "edit" ? null : { kind: "edit", id: f.id });
                        }}
                        className="rounded-sm p-1.5 text-muted hover:bg-ink/6 hover:text-ink disabled:text-line-strong disabled:hover:bg-transparent"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${f.part_name}`}
                        title={locked ? (lockedText ?? "Reopen the claim to change the estimate") : "Remove"}
                        disabled={locked}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMode(open === "remove" ? null : { kind: "remove", id: f.id });
                        }}
                        className="rounded-sm p-1.5 text-muted hover:bg-bad-soft hover:text-bad disabled:text-line-strong disabled:hover:bg-transparent"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                  <tr onClick={() => onSelect(f)} className="cursor-pointer">
                    <td colSpan={7} className="px-4 pt-0 pb-2.5">
                      {f.reason && f.source !== "adjuster" ? <p className="max-w-[78ch] text-muted">{f.reason}</p> : null}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint">
                        {agreement ? <span className="text-muted">{agreement}</span> : null}
                        {pi >= 0 ? <span>Photo {pi + 1}</span> : <span>No photo linked</span>}
                        {f.action === "unclear" ? <span>The AI couldn't tell repair from replace</span> : null}
                        {line ? (
                          <span className="num xl:hidden">
                            {[
                              line.part_price ? `Part ${money2(line.part_price)}` : "",
                              line.labour_hours ? `${line.labour_type === "body" ? "labour" : `${line.labour_type} labour`} ${hours(line.labour_hours)} h` : "",
                              line.paint_hours ? `paint ${hours(line.paint_hours)} h` : "",
                              line.sublet ? `sublet ${money2(line.sublet)}` : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        ) : null}
                        {line?.sublet ? <span className="num hidden xl:inline">Sublet {money2(line.sublet)}</span> : null}
                      </div>
                    </td>
                  </tr>
                  {open ? (
                    <tr>
                      <td colSpan={7} className="p-0">
                        {open === "edit" ? (
                          <FindingForm key={f.id} claimId={view.id} finding={f} line={line} onDone={done} onCancel={() => setMode(null)} />
                        ) : (
                          <RemovePanel claimId={view.id} finding={f} onDone={done} onCancel={() => setMode(null)} />
                        )}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              );
            })}
          </table>
        </div>
      ) : null}
      {mode?.kind === "add" ? (
        <FindingForm
          claimId={view.id}
          photoId={currentPhoto}
          photoLabel={photoIndex(currentPhoto ?? undefined) >= 0 ? `photo ${photoIndex(currentPhoto ?? undefined) + 1}, the one in the viewer` : undefined}
          onDone={done}
          onCancel={() => setMode(null)}
        />
      ) : null}
      {locked ? <p className="border-t border-line px-4 py-2 text-xs text-muted">{lockedText ?? "This claim has a decision. Reopen it to change the estimate."}</p> : null}
    </Card>
  );
}
