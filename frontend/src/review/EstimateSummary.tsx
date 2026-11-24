import type { ClaimView } from "../api";
import { money, money2, pct, range } from "../format";
import { Card, CardHeader, cx, SampleTag } from "../ui";

export function TotalsRows({ view }: { view: ClaimView }) {
  const t = view.estimate.totals;
  const rows: [string, string, number][] = [
    ["Parts", "", t.parts],
    ["Labour", t.labour_hours ? `${t.labour_hours.toFixed(1)} h` : "", t.labour],
    ["Paint labour", t.paint_hours ? `${t.paint_hours.toFixed(1)} h` : "", t.paint_labour],
    ["Paint materials", "", t.paint_materials],
    ["Sublet, paintless dent repair", "", t.sublet],
  ];
  return (
    <table className="w-full border-collapse text-[13px]">
      <tbody>
        {rows.map(([label, detail, amount]) => (
          <tr key={label} className="border-b border-line">
            <td className="py-1.5 pr-3 whitespace-nowrap">{label}</td>
            <td className="num py-1.5 pr-3 text-right whitespace-nowrap text-muted">{detail}</td>
            <td className="num w-28 py-1.5 text-right">{money2(amount)}</td>
          </tr>
        ))}
        <tr>
          <td className="pt-2 pr-3 font-semibold whitespace-nowrap">{t.is_range ? "Total, most likely" : "Total"}</td>
          <td />
          <td className="num pt-2 text-right text-base font-semibold">{money2(t.total)}</td>
        </tr>
        {t.is_range ? (
          <tr>
            <td className="pt-0.5 pr-3 text-muted">Range</td>
            <td />
            <td className="num pt-0.5 text-right whitespace-nowrap text-muted">{range(t.low, t.high, money2)}</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

export default function EstimateSummary({ view }: { view: ClaimView }) {
  const t = view.estimate.totals;
  const ratio = view.flags.value_ratio;
  const limit = view.settings.total_loss_ratio;
  const value = view.vehicle.value;
  const scale = Math.max(1, ratio ?? 0, limit) * 1.05;
  const over = ratio != null && ratio >= limit;
  return (
    <Card>
      <CardHeader title="Estimate" aside={<SampleTag />} />
      <div className="grid gap-x-8 gap-y-4 px-4 py-3 xl:grid-cols-2">
        <div>
          <TotalsRows view={view} />
        </div>
        <div className="space-y-3 text-[13px]">
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">Share of the car's value</span>
              <span className={cx("num font-semibold", over && "text-bad")}>{ratio != null ? pct(ratio) : "–"}</span>
            </div>
            {ratio != null ? (
              <>
                <div className="relative mt-2 h-2 rounded-full bg-line" role="img" aria-label={`The estimate is ${pct(ratio)} of the car's value; the total-loss threshold is ${pct(limit)}.`}>
                  <div className={cx("h-2 rounded-full", over ? "bg-bad" : "bg-ink")} style={{ width: `${Math.min(100, (ratio / scale) * 100)}%` }} />
                  <div className="absolute -top-1 h-4 w-0.5 bg-bad" style={{ left: `${(limit / scale) * 100}%` }} />
                </div>
                <p className="mt-2 text-muted">
                  {t.is_range ? "The top of the range" : "The estimate"} ({money(t.high)}) against a car value of {money(value)}. A claim is flagged as a
                  possible total loss at {pct(limit)}.
                </p>
              </>
            ) : (
              <p className="mt-1 text-muted">Not calculated for this claim. Total-loss threshold: {pct(limit)} of the car's value.</p>
            )}
          </div>
          <p className="border-t border-line pt-3 text-xs text-muted">
            Amount limit for fast-track: <span className="num">{money(view.settings.amount_threshold)}</span>. {view.estimate.note}
          </p>
        </div>
      </div>
    </Card>
  );
}
