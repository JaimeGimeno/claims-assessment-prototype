import type { ClaimSummary, Vehicle } from "./api";

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export const money = (n: number | null | undefined) => (n == null ? "–" : usd0.format(n));
export const money2 = (n: number | null | undefined) => (n == null ? "–" : usd2.format(n));
export const range = (low: number, high: number, fmt = money) => `${fmt(low)} – ${fmt(high)}`;
export const hours = (n: number | null | undefined) => (n ? n.toFixed(1) : "–");
export const pct = (ratio: number | null | undefined, digits = 0) => (ratio == null ? "–" : `${(ratio * 100).toFixed(digits)}%`);

export function claimEstimate(c: Pick<ClaimSummary, "estimate_total" | "estimate_low" | "estimate_high" | "estimate_is_range" | "n_findings">) {
  if (!c.n_findings) return "–";
  return c.estimate_is_range ? range(c.estimate_low, c.estimate_high) : money(c.estimate_total);
}

export function carName(v: Vehicle) {
  return [v.year, v.make, v.model].filter(Boolean).join(" ") || (v.assumed ? "Make and model not identified" : "Car not given");
}

export function dateTime(ts: number | null | undefined) {
  if (!ts) return "–";
  return new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function dateOnly(ts: number | null | undefined) {
  if (!ts) return "–";
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
export const plain = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ");

export const STATUS_NAMES: Record<string, string> = {
  pending: "Pending",
  agent_checked: "Checked by an agent, waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
  info_requested: "More information requested",
};

export const ROLE_NAMES: Record<string, string> = { agent: "Claims agent", senior: "Senior adjuster" };

/** Where a claim stands, in words that say whose turn it is. */
export function stageName(status: string, route: string | null | undefined, short = false): string {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "info_requested") return short ? "With policyholder" : "Waiting for the policyholder";
  if (status === "agent_checked") return short ? "Agent checked" : "Checked by an agent, ready for approval";
  if (route === "fast_track") return short ? "Ready to approve" : "Ready for approval";
  if (route === "need_more_information") return short ? "Agent to ask" : "Waiting for an agent to request information";
  return short ? "Agent check" : "Waiting for an agent's check";
}

export const AGREEMENT_TEXT: Record<string, string> = {
  both_runs: "Both AI runs agree",
  severity_differs: "The two runs disagree on severity",
  one_run: "Seen in one of two runs",
  adjuster: "Added by you",
};

export const ACTION_NAMES: Record<string, string> = {
  edit: "Edited",
  add: "Added",
  remove: "Removed",
  approve: "Approved",
  reject: "Rejected",
  request_info: "Requested more information",
  reopen: "Reopened",
  send_for_approval: "Sent for approval",
  send_back: "Sent back to the agent",
  rerun: "AI run live",
  settings: "Settings changed",
};
