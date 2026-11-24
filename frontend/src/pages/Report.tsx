import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Printer } from "lucide-react";
import { api } from "../api";
import type { ClaimView } from "../api";
import { useApp } from "../app-context";
import { cap, carName, dateOnly, hours, money, money2, pct, range, STATUS_NAMES } from "../format";
import { Button, ErrorNote, LoadingBlock } from "../ui";
import { TotalsRows } from "../review/EstimateSummary";

const OPS: Record<string, string> = { pdr: "Paintless dent repair" };

export default function Report() {
  const { id = "" } = useParams();
  const { name, reference } = useApp();
  const [view, setView] = useState<ClaimView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.claim(id).then(setView).catch((e: Error) => setError(e.message));
  };
  useEffect(load, [id]);
  useEffect(() => {
    const before = document.title;
    document.title = `Repair estimate ${id}`;
    return () => {
      document.title = before;
    };
  }, [id]);

  if (error) {
    return (
      <div className="mx-auto max-w-[860px] px-6 py-5">
        <ErrorNote onRetry={load}>{error}</ErrorNote>
      </div>
    );
  }
  if (!view) return <LoadingBlock label="Loading the estimate" />;

  const shop = reference.shops.find((s) => s.id === view.review.shop_id);
  const lines = view.estimate.lines;
  const t = view.estimate.totals;
  const findingById = new Map(view.findings.map((f) => [f.id, f]));
  const cell = "border-b border-line px-2 py-1.5 align-top";
  const num = `${cell} num text-right whitespace-nowrap`;
  const head = "border-b border-ink px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted";

  return (
    <div className="mx-auto max-w-[860px] px-6 py-5 print:max-w-none print:p-0">
      <div className="no-print mb-4 flex items-center justify-between gap-3">
        <Link to={`/claims/${view.id}`} className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-muted hover:text-ink">
          <ArrowLeft size={14} /> Back to {view.id}
        </Link>
        <Button variant="primary" icon={<Printer size={15} />} onClick={() => window.print()}>
          Print
        </Button>
      </div>

      <article className="print-plain rounded-lg border border-line bg-surface px-10 py-9 text-[13px]">
        <header className="flex items-start justify-between gap-6 border-b-2 border-ink pb-4">
          <div>
            <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em]">Repair estimate</h1>
            <p className="mt-1 text-muted">
              {view.review.status === "approved" ? "Approved by a senior adjuster." : "Draft. Not approved."} Prepared with AI assistance and checked by a person.
            </p>
          </div>
          <dl className="grid shrink-0 grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-right">
            <dt className="text-muted">Claim</dt>
            <dd className="num font-semibold">{view.id}</dd>
            <dt className="text-muted">Date</dt>
            <dd className="num">{dateOnly(view.review.decided_at ?? Date.now() / 1000)}</dd>
            <dt className="text-muted">Status</dt>
            <dd>{STATUS_NAMES[view.review.status]}</dd>
          </dl>
        </header>

        <section className="avoid-break grid grid-cols-2 gap-x-10 gap-y-3 border-b border-line py-4">
          <div>
            <h2 className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">Policyholder</h2>
            <p className="mt-1 font-medium">{view.policyholder || "–"}</p>
            <p className="num text-muted">{view.policy_number ? `Policy ${view.policy_number}` : "No policy number"}</p>
          </div>
          <div>
            <h2 className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">Car</h2>
            <p className="mt-1 font-medium">
              {carName(view.vehicle)}
              {view.vehicle.color ? `, ${view.vehicle.color}` : ""}
            </p>
            <p className="text-muted">
              {name("vehicle_classes", view.vehicle.vehicle_class)} · value <span className="num">{money(view.vehicle.value)}</span> (sample) ·{" "}
              {view.claim.drivable === false ? "not drivable" : "drivable"} · airbags {view.claim.airbags_deployed ? "deployed" : "not deployed"}
            </p>
          </div>
          {view.claim.accident_description ? (
            <div className="col-span-2">
              <h2 className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">Accident description</h2>
              <p className="mt-1">{view.claim.accident_description}</p>
            </div>
          ) : null}
        </section>

        <section className="py-4">
          <h2 className="mb-2 text-sm font-semibold">Damage found</h2>
          {view.findings.length === 0 ? (
            <p className="text-muted">No damage is listed on this estimate.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-x-6 gap-y-2.5">
              {view.findings.map((f, i) => (
                <li key={f.id} className="avoid-break flex gap-2.5">
                  {f.photo_id ? (
                    <img src={`/photos/${f.photo_id}?w=240`} alt="" className="h-[54px] w-[72px] shrink-0 rounded-sm border border-line object-cover" />
                  ) : (
                    <div className="flex h-[54px] w-[72px] shrink-0 items-center justify-center rounded-sm border border-line text-[10px] text-faint">No photo</div>
                  )}
                  <div className="min-w-0">
                    <div className="font-medium">
                      <span className="num text-muted">{i + 1}.</span> {f.part_name}
                      {f.side === "left" || f.side === "right" ? `, ${f.side}` : ""}
                    </div>
                    <div>
                      {name("damage_types", f.damage_type)}, {f.severity}
                      {f.source === "adjuster" ? " · added by the adjuster" : f.edited ? " · corrected by the adjuster" : ""}
                    </div>
                    {f.reason && f.source !== "adjuster" ? <div className="text-[12px] leading-snug text-muted">{f.reason}</div> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="py-2">
          <h2 className="mb-2 text-sm font-semibold">Estimate lines</h2>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={head}>Line</th>
                <th className={head}>Operation</th>
                <th className={head}>Part</th>
                <th className={head}>Side</th>
                <th className={`${head} text-right`}>Part price</th>
                <th className={`${head} text-right`}>Labour</th>
                <th className={`${head} text-right`}>Paint</th>
                <th className={`${head} text-right`}>Line total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.finding_id ?? i}>
                  <td className={`${cell} num text-muted`}>{i + 1}</td>
                  <td className={cell}>
                    {OPS[l.operation] ?? cap(l.operation)}
                    {findingById.get(l.finding_id)?.operation_override ? <span className="text-muted"> (set by adjuster)</span> : null}
                  </td>
                  <td className={cell}>{l.part_name}</td>
                  <td className={cell}>{l.side === "left" || l.side === "right" || l.side === "center" ? cap(l.side) : "–"}</td>
                  <td className={num}>{l.part_price ? money2(l.part_price) : "–"}</td>
                  <td className={num}>
                    {l.labour_hours ? (
                      <>
                        {hours(l.labour_hours)} h <span className="text-muted">{l.labour_type}</span>
                      </>
                    ) : l.sublet ? (
                      <span className="text-muted">sublet</span>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className={num}>{l.paint_hours ? `${hours(l.paint_hours)} h` : "–"}</td>
                  <td className={`${num} font-medium`}>
                    {l.is_range ? range(l.low, l.high, money2) : money2(l.total)}
                    {l.price_overridden ? <div className="text-[11px] font-normal text-muted">set by adjuster</div> : null}
                  </td>
                </tr>
              ))}
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={8} className={`${cell} text-muted`}>
                    No lines.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="mt-1.5 text-[12px] text-muted">
            Labour rates per hour: body ${reference.labour_rates.body}, paint ${reference.labour_rates.refinish}, mechanical ${reference.labour_rates.mechanical},
            structural ${reference.labour_rates.structural}; paint materials ${reference.labour_rates.paint_materials_per_refinish_hour} per paint hour.
          </p>
        </section>

        <section className="avoid-break grid grid-cols-2 gap-x-10 gap-y-4 py-4">
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold">Route: {view.route_name}</h2>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {view.routing.reasons.map((r, i) => (
                  <li key={i}>{r.text}</li>
                ))}
              </ul>
              {view.flags.value_ratio != null ? (
                <p className="mt-1.5 text-muted">
                  The estimate is {pct(view.flags.value_ratio)} of the car's value. Total-loss threshold: {pct(view.settings.total_loss_ratio)}.
                </p>
              ) : null}
            </div>
            <div>
              <h2 className="text-sm font-semibold">Authorised shop</h2>
              {shop && view.review.status === "approved" ? (
                <p className="mt-1">
                  {shop.name}, {shop.city}
                  {shop.structural ? " (structural work)" : ""} <span className="text-muted">(sample shop)</span>
                </p>
              ) : (
                <p className="mt-1 text-muted">None. This estimate has not been approved.</p>
              )}
              {view.review.note ? <p className="mt-1 whitespace-pre-line text-muted">Note: {view.review.note}</p> : null}
            </div>
          </div>
          <div>
            <h2 className="mb-1 text-sm font-semibold">Totals</h2>
            <TotalsRows view={view} />
            {t.is_range ? <p className="mt-1.5 text-[12px] text-muted">A range is shown where repair versus replace, or the severity, is not certain from the photos.</p> : null}
          </div>
        </section>

        <footer className="border-t border-line pt-3 text-[12px] text-muted">
          <p>
            <span className="font-medium text-ink">Sample data.</span> {view.estimate.note} {reference.note}
          </p>
          <p className="mt-1">This document comes from a prototype and is not a real repair authorisation.</p>
        </footer>
      </article>
    </div>
  );
}
