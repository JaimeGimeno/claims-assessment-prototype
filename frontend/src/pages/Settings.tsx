import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Confidence, Correction, PriceRow, Settings } from "../api";
import { useApp } from "../app-context";
import { cap, money2 } from "../format";
import { Button, Card, CardHeader, Chip, cx, ErrorNote, inputClass, LoadingBlock, PageHeader, SampleTag, td, tdNum, th, thNum, Toggle, useLoad } from "../ui";
import ChangeLog from "../review/ChangeLog";

function Row({ label, about, children }: { label: string; about: string; children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-x-6 gap-y-2 border-b border-line px-4 py-3 last:border-0 md:grid-cols-[minmax(0,1fr)_280px]">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        <p className="mt-0.5 max-w-2xl text-[13px] text-muted">{about}</p>
      </div>
      <div className="md:justify-self-end">{children}</div>
    </div>
  );
}

const RATE_NAMES: Record<string, string> = {
  body: "Body labour, per hour",
  refinish: "Paint labour, per hour",
  structural: "Structural labour, per hour",
  mechanical: "Mechanical labour, per hour",
  paint_materials_per_refinish_hour: "Paint materials, per paint hour",
};

export default function SettingsPage() {
  const { reference, name } = useApp();
  const saved = useLoad<Settings>(api.settings, []);
  const prices = useLoad<PriceRow[]>(api.priceTable, []);
  const log = useLoad<Correction[]>(api.corrections, []);

  const [amount, setAmount] = useState("");
  const [ratio, setRatio] = useState("");
  const [minConf, setMinConf] = useState<Confidence>("medium");
  const [severe, setSevere] = useState(true);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [vclass, setVclass] = useState("midsize_standard");

  const fill = (s: Settings) => {
    setAmount(String(s.amount_threshold));
    setRatio(String(Math.round(s.total_loss_ratio * 100)));
    setMinConf(s.min_confidence_fast_track);
    setSevere(s.severe_to_full_review);
    setModel(s.model);
  };
  useEffect(() => {
    if (saved.data) fill(saved.data);
  }, [saved.data]);

  const s = saved.data;
  const amountNum = Number(amount);
  const ratioNum = Number(ratio);
  const amountBad = amount.trim() === "" || Number.isNaN(amountNum) || amountNum < 0 || amountNum > 100000;
  const ratioBad = ratio.trim() === "" || Number.isNaN(ratioNum) || ratioNum < 30 || ratioNum > 100;
  const dirty =
    s != null &&
    (amountNum !== s.amount_threshold || Math.round(s.total_loss_ratio * 100) !== ratioNum || minConf !== s.min_confidence_fast_track || severe !== s.severe_to_full_review || model !== s.model);

  const save = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const next = await api.saveSettings({
        amount_threshold: amountNum,
        total_loss_ratio: ratioNum / 100,
        min_confidence_fast_track: minConf,
        severe_to_full_review: severe,
        model,
      });
      saved.setData(next);
      setDone(true);
      log.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const priceRows = useMemo(() => (prices.data ?? []).filter((r) => r.vehicle_class === vclass), [prices.data, vclass]);
  const h = (n: number | null) => (n == null ? "–" : n.toFixed(1));

  return (
    <div className="mx-auto max-w-[1560px] space-y-4 px-6 py-5">
      <PageHeader title="Settings" sub="The insurer sets the limits; the AI only reads the photos. Routes are worked out each time a claim is opened, so saving re-routes the whole queue." />

      <Card>
        <CardHeader title="Routing rules" />
        {saved.loading && !s ? <LoadingBlock /> : null}
        {saved.error ? <ErrorNote className="m-3" onRetry={saved.reload}>{saved.error}</ErrorNote> : null}
        {s ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty && !amountBad && !ratioBad) void save();
            }}
          >
            <Row label="Amount limit for fast-track" about="A claim whose estimate is above this goes to full review. Raising it lets more claims be approved in one click; lowering it sends more to a claims agent first.">
              <div className="flex items-center gap-2">
                <span className="text-muted">$</span>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount limit in dollars" aria-invalid={amountBad} className={cx(inputClass, "num w-32 text-right")} />
              </div>
              {amountBad ? <p className="mt-1 text-xs text-bad">Between 0 and 100,000.</p> : null}
            </Row>
            <Row label="Total-loss threshold" about="When the estimate reaches this share of the car's value, the claim is flagged as a possible total loss and goes to full review. Lowering it flags more claims.">
              <div className="flex items-center gap-2">
                <input value={ratio} onChange={(e) => setRatio(e.target.value)} inputMode="numeric" aria-label="Total-loss threshold in percent" aria-invalid={ratioBad} className={cx(inputClass, "num w-32 text-right")} />
                <span className="whitespace-nowrap text-muted">% of car value</span>
              </div>
              {ratioBad ? <p className="mt-1 text-xs text-bad">Between 30 and 100.</p> : null}
            </Row>
            <Row label="Minimum confidence for fast-track" about="A claim with any finding below this level goes to full review. High means both AI runs must agree on everything; low lets uncertain findings through.">
              <select value={minConf} onChange={(e) => setMinConf(e.target.value as Confidence)} aria-label="Minimum confidence" className={cx(inputClass, "w-44")}>
                {(["high", "medium", "low"] as const).map((c) => (
                  <option key={c} value={c}>
                    {cap(c)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Send severe damage to full review" about="When on, a claim with any severely damaged part goes to full review even if the estimate is under the limit.">
              <Toggle checked={severe} onChange={setSevere} label="Send severe damage to full review" />
            </Row>
            <Row label="AI model" about="Used for live runs from now on. Stored results keep the model they were made with. Larger models cost more per claim and take longer.">
              <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="AI model" className={cx(inputClass, "w-56")}>
                {reference.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Row>
            <div className="flex flex-wrap items-center gap-3 border-t border-line bg-subtle px-4 py-2.5">
              <Button type="submit" variant="primary" busy={busy} disabled={!dirty || amountBad || ratioBad}>
                Save and re-route
              </Button>
              <Button variant="ghost" disabled={!dirty || busy} onClick={() => fill(s)}>
                Discard changes
              </Button>
              {done && !dirty ? <span className="text-[13px] text-ok">Saved. The queue now uses these rules.</span> : null}
              {error ? <ErrorNote>{error}</ErrorNote> : null}
            </div>
          </form>
        ) : null}
      </Card>

      <div className="grid items-start gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Labour rates" aside={<Chip tone="ok">Real published rates</Chip>} />
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {Object.entries(reference.labour_rates).map(([k, v]) => (
                <tr key={k} className="border-b border-line last:border-0">
                  <td className={td}>{RATE_NAMES[k] ?? cap(k.replace(/_/g, " "))}</td>
                  <td className={tdNum}>{money2(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line px-3 py-2 text-xs text-muted">Published median rates. In production these would be the rates agreed with the insurer's shop network.</p>
        </Card>

        <Card>
          <CardHeader
            title="Price table"
            aside={
              <>
                <SampleTag />
                <select value={vclass} onChange={(e) => setVclass(e.target.value)} aria-label="Vehicle class" className={cx(inputClass, "h-8 w-auto")}>
                  {reference.vehicle_classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </>
            }
          />
          {prices.loading && !prices.data ? <LoadingBlock /> : null}
          {prices.error ? <ErrorNote className="m-3" onRetry={prices.reload}>{prices.error}</ErrorNote> : null}
          {prices.data ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-subtle">
                    <th className={th}>Part</th>
                    <th className={thNum}>Part price</th>
                    <th className={thNum}>Replace h</th>
                    <th className={thNum}>Repair h, minor</th>
                    <th className={thNum}>Moderate</th>
                    <th className={thNum}>Severe</th>
                    <th className={thNum}>Paint h</th>
                    <th className={thNum}>Paintless dent repair</th>
                  </tr>
                </thead>
                <tbody>
                  {priceRows.map((r) => (
                    <tr key={r.part} className="border-b border-line last:border-0">
                      <td className={td}>{name("parts", r.part)}</td>
                      <td className={tdNum}>{r.part_price == null ? "–" : money2(r.part_price)}</td>
                      <td className={tdNum}>{h(r.replace_hours)}</td>
                      <td className={tdNum}>{h(r.repair_hours.minor)}</td>
                      <td className={tdNum}>{h(r.repair_hours.moderate)}</td>
                      <td className={tdNum}>{h(r.repair_hours.severe)}</td>
                      <td className={tdNum}>{r.refinish_hours ? r.refinish_hours.toFixed(1) : "–"}</td>
                      <td className={tdNum}>{r.pdr_price == null ? "–" : money2(r.pdr_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="border-t border-line px-3 py-2 text-xs text-muted">
            Part prices, labour hours, class differences, shops and car values are sample data. In production this is the insurer's licensed estimating database.
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader title="Change log, all claims" sub={log.data ? `${log.data.length} entries, newest first` : undefined} />
        {log.loading && !log.data ? <LoadingBlock /> : null}
        {log.error ? <ErrorNote className="m-3" onRetry={log.reload}>{log.error}</ErrorNote> : null}
        {log.data ? <ChangeLog rows={log.data} showClaim /> : null}
      </Card>
    </div>
  );
}
