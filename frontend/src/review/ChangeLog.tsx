import { Link } from "react-router";
import type { Correction } from "../api";
import { useApp } from "../app-context";
import { ACTION_NAMES, dateTime, plain, ROLE_NAMES } from "../format";
import { td, th } from "../ui";

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return plain(String(v));
}

const SETTING_NAMES: Record<string, string> = {
  amount_threshold: "Amount limit",
  total_loss_ratio: "Total-loss threshold",
  min_confidence_fast_track: "Minimum confidence",
  severe_to_full_review: "Severe damage to full review",
  model: "AI model",
};

export default function ChangeLog({ rows, showClaim }: { rows: Correction[]; showClaim?: boolean }) {
  const { name } = useApp();
  if (rows.length === 0) {
    return <p className="px-4 py-6 text-center text-[13px] text-muted">No changes yet. Edits, hand-overs, decisions and live AI runs are recorded here, with who made them.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line bg-subtle">
            <th className={th}>Time</th>
            {showClaim ? <th className={th}>Claim</th> : null}
            <th className={th}>By</th>
            <th className={th}>Action</th>
            <th className={th}>What changed</th>
            <th className={th}>Reason</th>
            <th className={th}>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-0">
              <td className={`${td} num whitespace-nowrap text-muted`}>{dateTime(r.ts)}</td>
              {showClaim ? (
                <td className={`${td} num whitespace-nowrap`}>
                  {r.claim_id ? (
                    <Link to={`/claims/${r.claim_id}`} className="font-medium hover:underline">
                      {r.claim_id}
                    </Link>
                  ) : (
                    <span className="text-muted">All claims</span>
                  )}
                </td>
              ) : null}
              <td className={`${td} whitespace-nowrap`}>{ROLE_NAMES[r.actor] ?? <span className="text-faint">–</span>}</td>
              <td className={`${td} whitespace-nowrap`}>{ACTION_NAMES[r.action] ?? plain(r.action)}</td>
              <td className={td}>
                {r.finding ? <span className="font-medium">{r.finding}</span> : null}
                {r.changes.length ? (
                  <ul className={r.finding ? "mt-0.5" : ""}>
                    {r.changes.map((c, i) => (
                      <li key={i} className="text-muted">
                        {SETTING_NAMES[c.field] ?? c.field}: {c.from === null || c.from === undefined ? "" : `${show(c.from)} → `}
                        <span className="text-ink">{show(c.to)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!r.finding && !r.changes.length ? <span className="text-faint">–</span> : null}
              </td>
              <td className={td}>{r.reason_code ? name("edit_reasons", r.reason_code) : <span className="text-faint">–</span>}</td>
              <td className={`${td} max-w-[280px] whitespace-pre-line`}>{r.note || <span className="text-faint">–</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
