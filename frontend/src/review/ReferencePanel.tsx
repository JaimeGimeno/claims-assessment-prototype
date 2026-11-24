import { useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import type { ReferencePanelData, RefRow } from "../api";
import { useApp } from "../app-context";
import { money2 } from "../format";
import { Card, Chip, cx, td, th } from "../ui";

function Tick({ ok }: { ok: boolean | null | undefined }) {
  if (ok === null || ok === undefined) return <span className="text-faint">–</span>;
  return ok ? (
    <Check size={14} className="inline text-ok" aria-label="Correct" />
  ) : (
    <X size={14} className="inline text-bad" aria-label="Wrong" />
  );
}

const STATUS: Record<RefRow["status"], { label: string; tone: "ok" | "bad" | "warn" | "neutral" }> = {
  matched: { label: "Found", tone: "ok" },
  missed: { label: "Missed", tone: "bad" },
  extra: { label: "Extra", tone: "warn" },
  optional_not_found: { label: "Optional, not found", tone: "neutral" },
};

export default function ReferencePanel({ data }: { data: ReferencePanelData }) {
  const { name } = useApp();
  const [open, setOpen] = useState(false);
  const c = data.compare;
  const gap = data.ai_total - data.reference_total;
  const describe = (f: { part: string; part_name?: string; side?: string; damage_type: string; severity: string } | null) =>
    f ? (
      <>
        <span className="font-medium">{f.part_name ?? name("parts", f.part)}</span>
        {f.side === "left" || f.side === "right" ? `, ${f.side}` : ""}
        <span className="text-muted">
          {" "}
          · {name("damage_types", f.damage_type).toLowerCase()} · {f.severity}
        </span>
      </>
    ) : (
      <span className="text-faint">–</span>
    );
  return (
    <Card className="border-dashed border-line-strong">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-4 py-2.5 text-left">
        {open ? <ChevronDown size={15} className="text-muted" /> : <ChevronRight size={15} className="text-muted" />}
        <span className="text-sm font-semibold">Compare with the reference labels</span>
        <Chip tone="plain">Prototype only</Chip>
        <span className="text-[13px] text-muted">An adjuster wouldn't have this. It shows how the AI did on this sample claim.</span>
      </button>
      {open ? (
        <div className="border-t border-line">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5 text-[13px]">
            <Chip tone={data.tier === "human" ? "ok" : "warn"}>{data.tier === "human" ? "Human-checked labels" : "AI-generated labels, not checked by a person"}</Chip>
            <span className="num">
              Found {c.found} of {c.required} required
            </span>
            <span className="num">{c.missed} missed</span>
            <span className="num">{c.extra} extra</span>
            <span className="num text-muted">
              Of {c.matched} matched: severity {c.severity_ok}, type {c.type_ok}, side {c.side_ok} correct
            </span>
          </div>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-subtle">
                  <th className={th}>The labels say</th>
                  <th className={th}>The AI found</th>
                  <th className={th}>Result</th>
                  <th className={cx(th, "text-center")}>Severity</th>
                  <th className={cx(th, "text-center")}>Type</th>
                  <th className={cx(th, "text-center")}>Side</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className={td}>
                      {describe(r.ref)}
                      {r.ref && r.optional ? <span className="ml-1.5 text-xs text-faint">optional</span> : null}
                      {r.ref?.note ? <div className="text-xs text-muted">{r.ref.note}</div> : null}
                    </td>
                    <td className={td}>{describe(r.ai)}</td>
                    <td className={td}>
                      <Chip tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Chip>
                    </td>
                    <td className={cx(td, "text-center")}>{r.status === "matched" ? <Tick ok={r.severity_ok} /> : <span className="text-faint">–</span>}</td>
                    <td className={cx(td, "text-center")}>{r.status === "matched" ? <Tick ok={r.type_ok} /> : <span className="text-faint">–</span>}</td>
                    <td className={cx(td, "text-center")}>{r.status === "matched" ? <Tick ok={r.side_ok} /> : <span className="text-faint">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-line px-4 py-2.5 text-[13px]">
            <span>
              AI estimate, before edits <span className="num font-semibold">{money2(data.ai_total)}</span>
            </span>
            <span>
              Priced from the labels <span className="num font-semibold">{money2(data.reference_total)}</span>
            </span>
            <span>
              Gap{" "}
              <span className="num font-semibold">
                {gap === 0 ? "none" : `${gap > 0 ? "+" : "−"}${money2(Math.abs(gap))}`}
              </span>
            </span>
            {data.structural_suspected ? <span className="text-muted">The labels mark structural damage as suspected.</span> : null}
            {data.ambiguous ? <span className="text-muted">The labeller marked this claim as ambiguous.</span> : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
