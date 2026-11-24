import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import type { EvalPayload, EvalResult } from "../api";
import { useApp } from "../app-context";
import { cap, money, money2, plain } from "../format";
import { Card, CardHeader, Chip, cx, Empty, ErrorNote, LoadingBlock, PageHeader, SampleTag, td, tdNum, th, thNum, useLoad } from "../ui";

const p1 = (n: number | undefined | null) => (n == null ? "–" : `${n.toFixed(1)}%`);

const METRICS: { key: string; label: string; about: string }[] = [
  { key: "recall", label: "Recall", about: "Of the damaged parts in the labels, the share the AI found." },
  { key: "precision", label: "Precision", about: "Of the damaged parts the AI reported, the share that are in the labels." },
  { key: "damage_type_accuracy", label: "Type", about: "Of the parts found, the share with the right damage type (dent, scratch, crack and so on)." },
  { key: "severity_accuracy", label: "Severity", about: "Of the parts found, the share with the right severity (minor, moderate or severe)." },
  { key: "side_accuracy", label: "Side", about: "Of the parts found, the share on the right side of the car." },
  { key: "route_agreement", label: "Route", about: "The share of claims sent to the same route as the labels would send them." },
  { key: "mean_abs_gap_usd", label: "Mean $ gap", about: "The average dollar difference between the AI's estimate and the estimate priced from the labels." },
  { key: "claims_within_20pct", label: "Within 20%", about: "The share of claims where the AI's estimate is within 20% of the estimate priced from the labels." },
  { key: "cost_per_claim_usd", label: "Cost per claim", about: "What the AI calls cost for one claim, at list prices. An asterisk marks prices that are estimates." },
  { key: "median_latency_s", label: "Median seconds", about: "How long the AI took on the middle claim." },
];

const conditionName = (c?: string) => (c === "with_description" ? "With description" : c === "without_description" ? "Without description" : cap(plain(c)) || "–");

function ResultsTable({ rows, picked, onPick }: { rows: EvalResult[]; picked?: number; onPick?: (i: number) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1040px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line bg-subtle">
            <th className={th}>AI model</th>
            <th className={th}>Accident description</th>
            {METRICS.map((m) => (
              <th key={m.key} className={thNum} title={m.about}>
                <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-4">{m.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={`${r.model}-${r.condition}-${i}`}
              onClick={onPick ? () => onPick(i) : undefined}
              aria-selected={picked === i}
              className={cx("border-b border-line last:border-0", onPick && "cursor-pointer", picked === i ? "bg-accent-soft/60" : onPick && "hover:bg-subtle")}
            >
              <td className={cx(td, "font-medium whitespace-nowrap")}>
                {onPick ? (
                  <button type="button" onClick={() => onPick(i)} className="text-left hover:underline">
                    {r.model_name ?? r.model}
                  </button>
                ) : (
                  (r.model_name ?? r.model)
                )}
              </td>
              <td className={cx(td, "whitespace-nowrap")}>{conditionName(r.condition)}</td>
              <td className={tdNum}>{p1(r.recall)}</td>
              <td className={tdNum}>{p1(r.precision)}</td>
              <td className={tdNum}>{p1(r.damage_type_accuracy)}</td>
              <td className={tdNum}>{p1(r.severity_accuracy)}</td>
              <td className={tdNum}>{p1(r.side_accuracy)}</td>
              <td className={tdNum}>{p1(r.route_agreement)}</td>
              <td className={tdNum}>{r.mean_abs_gap_usd == null ? "–" : money(r.mean_abs_gap_usd)}</td>
              <td className={tdNum}>{p1(r.claims_within_20pct)}</td>
              <td className={tdNum}>
                {r.cost_per_claim_usd == null ? "–" : `$${r.cost_per_claim_usd.toFixed(3)}`}
                {r.price_is_estimate ? <span title="The price of this model is an estimate">*</span> : null}
              </td>
              <td className={tdNum}>{r.median_latency_s == null ? "–" : r.median_latency_s.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ r }: { r: EvalResult }) {
  const { reference } = useApp();
  const routeName = (id: string) => reference.routes[id] ?? cap(plain(id));
  const conf = r.errors_by_confidence;
  const s = r.structural;
  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 lg:grid-cols-3">
        {conf ? (
          <Card>
            <CardHeader title="Do uncertain findings turn out wrong more often?" />
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line bg-subtle">
                  <th className={th}>Confidence</th>
                  <th className={thNum}>Findings</th>
                  <th className={thNum}>Wrong</th>
                  <th className={thNum}>Error rate</th>
                </tr>
              </thead>
              <tbody>
                {(["high", "medium", "low"] as const)
                  .filter((k) => conf[k])
                  .map((k) => (
                    <tr key={k} className="border-b border-line last:border-0">
                      <td className={td}>{cap(k)}</td>
                      <td className={tdNum}>{conf[k].findings}</td>
                      <td className={tdNum}>{conf[k].wrong}</td>
                      <td className={tdNum}>{p1(conf[k].error_rate)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="border-t border-line px-3 py-2 text-xs text-muted">
              A finding counts as wrong when it is not in the labels, or its type, severity or side is off. Confidence comes from whether the two AI runs agree.
            </p>
          </Card>
        ) : null}
        {s ? (
          <Card>
            <CardHeader title="Structural damage flag" />
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {[
                  ["Flagged, and the labels agree", s.tp],
                  ["Flagged, but not in the labels", s.fp],
                  ["Missed: in the labels, not flagged", s.fn],
                  ["Not flagged, and the labels agree", s.tn],
                ].map(([label, n]) => (
                  <tr key={label} className="border-b border-line last:border-0">
                    <td className={td}>{label}</td>
                    <td className={tdNum}>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-line px-3 py-2 text-xs text-muted">One of the two runs seeing structural signs is enough to flag a claim, so false alarms are expected and misses matter most.</p>
          </Card>
        ) : null}
        <Card>
          <CardHeader title="Photo checks" />
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              <tr className="border-b border-line">
                <td className={td}>Unusable photos caught</td>
                <td className={tdNum}>{r.unusable_photos_caught ?? "–"}</td>
              </tr>
              <tr className="border-b border-line">
                <td className={td}>Usable photos wrongly rejected</td>
                <td className={tdNum}>{r.usable_photos_wrongly_rejected ?? "–"}</td>
              </tr>
              <tr>
                <td className={td}>Claims, runs per claim</td>
                <td className={tdNum}>
                  {r.claims ?? "–"}, {r.runs_per_claim ?? "–"}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>

      {r.per_claim?.length ? (
        <Card>
          <CardHeader title="Claim by claim" sub={`${r.model_name ?? r.model}, ${conditionName(r.condition).toLowerCase()}`} aside={<SampleTag>Sample prices</SampleTag>} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line bg-subtle">
                  <th className={th}>Claim</th>
                  <th className={th}>Car</th>
                  <th className={thNum}>Found of required</th>
                  <th className={thNum}>Extra</th>
                  <th className={thNum}>AI total</th>
                  <th className={thNum}>Label total</th>
                  <th className={thNum}>Gap</th>
                  <th className={th}>AI route</th>
                  <th className={th}>Label route</th>
                </tr>
              </thead>
              <tbody>
                {r.per_claim.map((c) => {
                  const same = c.route_ai === c.route_reference;
                  return (
                    <tr key={c.claim_id} className="border-b border-line last:border-0 hover:bg-subtle">
                      <td className={cx(td, "num whitespace-nowrap")}>
                        <Link to={`/claims/${c.claim_id}`} className="font-medium text-accent hover:underline">
                          {c.claim_id}
                        </Link>
                      </td>
                      <td className={cx(td, "whitespace-nowrap")}>{c.car ?? "–"}</td>
                      <td className={cx(tdNum, c.found < c.required && "font-medium text-bad")}>
                        {c.found} of {c.required}
                      </td>
                      <td className={tdNum}>{c.extra || "–"}</td>
                      <td className={tdNum}>{money2(c.ai_total)}</td>
                      <td className={tdNum}>{money2(c.reference_total)}</td>
                      <td className={tdNum}>{c.gap === 0 ? "–" : `${c.gap > 0 ? "+" : "−"}${money2(Math.abs(c.gap))}`}</td>
                      <td className={cx(td, "whitespace-nowrap")}>{routeName(c.route_ai)}</td>
                      <td className={cx(td, "whitespace-nowrap")}>
                        {routeName(c.route_reference)} {same ? null : <Chip tone="warn">Differs</Chip>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function KeyValues({ data }: { data: Record<string, unknown> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 text-[13px] md:grid-cols-4">
      {Object.entries(data).map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted">{cap(plain(k))}</dt>
          <dd className="num mt-0.5 font-medium">{v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function Evaluation() {
  const { data, error, loading, reload } = useLoad<EvalPayload>(api.evaluation, []);
  const [picked, setPicked] = useState(0);
  const [pickedAi, setPickedAi] = useState(0);
  const results = data?.results ?? [];
  const current = results[Math.min(picked, results.length - 1)];
  const al = data?.ai_labelling;

  return (
    <div className="mx-auto max-w-[1560px] px-6 py-5">
      <PageHeader
        title="Evaluation"
        sub="How well the AI reads damage, measured against labelled photos. It tests the damage reading, not real repair costs."
        aside={data?.generated_at ? <span className="num text-xs text-muted">Run on {data.generated_at}</span> : undefined}
      />
      {loading && !data ? <LoadingBlock label="Loading results" /> : null}
      {error ? <ErrorNote onRetry={reload}>{error}</ErrorNote> : null}
      {data && !data.available ? (
        <Card>
          <Empty title="The results aren't ready yet">The evaluation hasn't been run on this server. Once it has, the results show here.</Empty>
        </Card>
      ) : null}

      {data?.available ? (
        <div className="space-y-4">
          <Card>
            {data.dataset ? (
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-line px-4 py-3 text-[13px]">
                {(["claims", "photos", "required_findings"] as const)
                  .filter((k) => data.dataset?.[k] != null)
                  .map((k) => (
                    <span key={k}>
                      <span className="num text-base font-semibold">{data.dataset?.[k]}</span> <span className="text-muted">{k === "required_findings" ? "damaged parts in the labels" : k}</span>
                    </span>
                  ))}
                {data.dataset.labelled_by ? <span className="text-muted">{data.dataset.labelled_by}</span> : null}
              </div>
            ) : null}
            {data.notes?.length ? (
              <ul className="list-disc space-y-1 py-3 pr-4 pl-8 text-[13px] text-muted">
                {data.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Results" sub={results.length > 1 ? "Pick a row to see its details below." : "Two runs per claim, merged."} aside={<SampleTag>Dollar gaps use sample prices</SampleTag>} />
            {results.length ? <ResultsTable rows={results} picked={Math.min(picked, results.length - 1)} onPick={setPicked} /> : <Empty title="No results in the file" />}
            <dl className="grid gap-x-8 gap-y-1.5 border-t border-line px-4 py-3 text-xs md:grid-cols-2">
              {METRICS.map((m) => (
                <div key={m.key} className="flex gap-2">
                  <dt className="w-28 shrink-0 font-medium">{m.label}</dt>
                  <dd className="text-muted">{m.about}</dd>
                </div>
              ))}
            </dl>
          </Card>

          {current ? <Detail r={current} /> : null}

          {data.single_run?.length ? (
            <Card>
              <CardHeader title="One run versus the merged two" sub="What a single AI run scores on its own." />
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-subtle">
                      <th className={th}>AI model</th>
                      <th className={th}>Runs</th>
                      <th className={thNum}>Recall</th>
                      <th className={thNum}>Precision</th>
                      <th className={thNum}>Severity</th>
                      <th className={thNum}>Within 20%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.single_run.map((sr, i) => {
                      const merged = results.find((x) => x.model === sr.model && x.condition === sr.condition);
                      return [
                        <tr key={`s${i}`} className="border-b border-line">
                          <td className={cx(td, "font-medium")}>{sr.model_name ?? sr.model}</td>
                          <td className={td}>One run</td>
                          <td className={tdNum}>{p1(sr.recall)}</td>
                          <td className={tdNum}>{p1(sr.precision)}</td>
                          <td className={tdNum}>{p1(sr.severity_accuracy)}</td>
                          <td className={tdNum}>{p1(sr.claims_within_20pct)}</td>
                        </tr>,
                        merged ? (
                          <tr key={`m${i}`} className="border-b border-line last:border-0">
                            <td className={cx(td, "font-medium")}>{merged.model_name ?? merged.model}</td>
                            <td className={td}>Two runs, merged</td>
                            <td className={tdNum}>{p1(merged.recall)}</td>
                            <td className={tdNum}>{p1(merged.precision)}</td>
                            <td className={tdNum}>{p1(merged.severity_accuracy)}</td>
                            <td className={tdNum}>{p1(merged.claims_within_20pct)}</td>
                          </tr>
                        ) : null,
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {al?.available ? (
            <>
              <h2 className="pt-2 text-base font-semibold">Scored against AI-generated labels</h2>
              <Card>
                {al.method ? <p className="px-4 py-3 text-[13px] text-muted">{al.method}</p> : null}
                {al.agreement_with_human ? (
                  <div className="border-t border-line">
                    <div className="px-4 pt-3 text-[13px] font-semibold">How well the AI labels agree with the human ones</div>
                    <KeyValues data={al.agreement_with_human} />
                  </div>
                ) : null}
              </Card>
              {al.results?.length ? (
                <>
                  <Card>
                    <CardHeader title="Results on AI-labelled photos" sub="These labels were not checked by a person." />
                    <ResultsTable rows={al.results} picked={Math.min(pickedAi, al.results.length - 1)} onPick={setPickedAi} />
                  </Card>
                  <Detail r={al.results[Math.min(pickedAi, al.results.length - 1)]} />
                </>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
