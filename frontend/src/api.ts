// Types and calls for the backend API. Every call sends the session cookie;
// a 401 anywhere sends the browser to the server's own sign-in page.

export type Route = "fast_track" | "full_review" | "need_more_information" | null;
export type Status = "pending" | "agent_checked" | "approved" | "rejected" | "info_requested";
/** The two people in the flow. The demo has a switch, not accounts. */
export type Role = "agent" | "senior";
/** Whose turn a claim is. null means it has a decision. */
export type Owner = Role | "policyholder" | null;

const ROLE_KEY = "claims.role";
function savedRole(): Role {
  try {
    return localStorage.getItem(ROLE_KEY) === "agent" ? "agent" : "senior";
  } catch {
    return "senior";
  }
}
let currentRole: Role = savedRole();
export const getRole = () => currentRole;
export function setRole(role: Role) {
  currentRole = role;
  try {
    localStorage.setItem(ROLE_KEY, role);
  } catch {
    // storage can be unavailable in private windows; the role still holds for this visit
  }
}
export type Confidence = "high" | "medium" | "low";
export type Severity = "minor" | "moderate" | "severe";

export interface Vehicle {
  make?: string;
  model?: string;
  year?: number | null;
  color?: string;
  vehicle_class?: string;
  value?: number;
  /** true when the car was worked out by the AI on a try-out, not taken from a policy */
  assumed?: boolean;
}

export interface Reason {
  code: string;
  text: string;
}

export interface Flags {
  total_loss?: boolean;
  structural?: boolean;
  value_ratio?: number;
}

export interface ClaimSummary {
  id: string;
  policy_number: string;
  policyholder: string;
  vehicle: Vehicle;
  photos: string[];
  sample: boolean;
  source: string;
  created_at: number | null;
  route: Route;
  route_name: string;
  route_reasons: Reason[];
  flags: Flags;
  estimate_total: number;
  estimate_low: number;
  estimate_high: number;
  estimate_is_range: boolean;
  n_findings: number;
  status: Status;
  owner: Owner;
  assessed: boolean;
  assessment_failed: boolean;
  model: string | null;
  live: boolean | null;
  edited: boolean;
}

export interface Finding {
  id: string;
  part: string;
  part_name: string;
  side: string;
  damage_type: string;
  severity: Severity;
  severity_alt?: Severity;
  action?: string;
  paint_damaged?: boolean;
  confidence: Confidence;
  photo_id?: string;
  reason?: string;
  agreement?: string;
  source?: string;
  edited?: boolean;
  operation_override?: string;
  price_override?: number | null;
}

export interface EstimateLine {
  finding_id: string;
  part: string;
  part_name: string;
  side: string;
  damage_type: string;
  severity: string;
  operation: string;
  part_price: number;
  labour_hours: number;
  labour_type: string;
  labour_rate: number;
  labour_cost: number;
  paint_hours: number;
  paint_labour: number;
  paint_materials: number;
  sublet: number;
  total: number;
  low: number;
  high: number;
  is_range: boolean;
  price_overridden?: boolean;
}

export interface Totals {
  parts: number;
  labour: number;
  labour_by_type: Record<string, number>;
  labour_hours: number;
  paint_labour: number;
  paint_hours: number;
  paint_materials: number;
  sublet: number;
  total: number;
  low: number;
  high: number;
  is_range: boolean;
}

export interface PhotoItem {
  id: string;
  url: string;
  usable: boolean;
  issue_text: string;
  view: string;
  runs_disagree: boolean;
}

export interface Assessment {
  status: string;
  error: string | null;
  model: string | null;
  cost_usd: number | null;
  latency_s: number | null;
  n_runs: number | null;
  assessed_at: number | null;
  live: boolean | null;
  vehicle_check: { seen?: string; match?: string; reason?: string } | null;
  description_check: { consistent?: string; reason?: string } | null;
  structural_suspected: boolean | null;
  structural_reason: string | null;
  structural_runs: string | null;
  info_requests: string[] | null;
  suggested_vehicle_class: string | null;
}

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

export interface Correction {
  id: number;
  ts: number;
  claim_id: string | null;
  action: string;
  finding: string;
  changes: Change[];
  reason_code: string;
  note: string;
  /** who made the change; empty on entries from before roles existed */
  actor: Role | "";
}

export interface RefFinding {
  part: string;
  part_name: string;
  side?: string;
  damage_type: string;
  severity: string;
  note?: string;
  optional?: boolean;
  also_ok_severity?: string[];
  also_ok_damage_type?: string[];
  also_ok_part?: string[];
}

export interface RefRow {
  status: "matched" | "missed" | "extra" | "optional_not_found";
  optional: boolean;
  ref: RefFinding | null;
  ai: { id?: string; part: string; part_name?: string; side?: string; damage_type: string; severity: string; confidence?: string } | null;
  severity_ok?: boolean | null;
  type_ok?: boolean | null;
  side_ok?: boolean | null;
}

export interface ReferencePanelData {
  tier: "human" | "ai";
  findings: RefFinding[];
  structural_suspected: boolean;
  ambiguous: boolean;
  compare: {
    required: number;
    found: number;
    missed: number;
    extra: number;
    ai_total: number;
    matched: number;
    severity_ok: number;
    type_ok: number;
    side_ok: number;
  };
  rows: RefRow[];
  reference_total: number;
  ai_total: number;
}

export interface Settings {
  amount_threshold: number;
  total_loss_ratio: number;
  min_confidence_fast_track: Confidence;
  severe_to_full_review: boolean;
  model: string;
}

export interface ClaimView extends ClaimSummary {
  claim: {
    id: string;
    accident_description?: string;
    drivable?: boolean;
    airbags_deployed?: boolean;
  };
  photo_list: PhotoItem[];
  assessment: Assessment | null;
  findings: Finding[];
  estimate: { lines: EstimateLine[]; totals: Totals; note: string };
  routing: { route: Route; reasons: Reason[]; flags: Flags; notes?: string[]; info_requests: string[] };
  review: { status: Status; shop_id: string | null; note: string | null; decided_at: number | null };
  corrections: Correction[];
  reference: ReferencePanelData | null;
  settings: Settings;
}

export interface Named {
  id: string;
  name: string;
}

export interface Shop extends Named {
  city: string;
  structural: boolean;
}

export interface Preset {
  id: string;
  make: string;
  model: string;
  year: number;
  vehicle_class: string;
  value: number;
}

export interface Reference {
  note: string;
  parts: (Named & { structural?: boolean })[];
  damage_types: Named[];
  severities: (Named & { meaning: string })[];
  vehicle_classes: Named[];
  labour_rates: Record<string, number>;
  shops: Shop[];
  vehicle_presets: Preset[];
  edit_reasons: Named[];
  routes: Record<string, string>;
  models: Named[];
  limits: { max_photos: number; max_upload_mb: number };
  operations: Named[];
}

export interface Usage {
  live_runs_today: number;
  daily_cap: number;
  live_runs: number;
  cost_usd: number;
}

export interface Sample {
  id: string;
  url: string;
  source: string;
  tier: "human" | "ai" | "dev";
  label_tier: string | null;
  car: string;
  view: string;
  stored_result: boolean;
}

export interface PriceRow {
  vehicle_class: string;
  part: string;
  part_price: number | null;
  replace_hours: number | null;
  repair_hours: { minor: number | null; moderate: number | null; severe: number | null };
  refinish_hours: number;
  pdr_price: number | null;
}

export interface EvalPerClaim {
  claim_id: string;
  car?: string;
  photos?: number;
  required: number;
  found: number;
  extra: number;
  ai_total: number;
  reference_total: number;
  gap: number;
  route_ai: string;
  route_reference: string;
  structural_ai?: boolean;
  structural_reference?: boolean;
}

export interface EvalResult {
  model: string;
  model_name?: string;
  condition?: string;
  claims?: number;
  runs_per_claim?: number;
  recall?: number;
  precision?: number;
  damage_type_accuracy?: number;
  severity_accuracy?: number;
  side_accuracy?: number;
  route_agreement?: number;
  mean_abs_gap_usd?: number;
  median_abs_gap_pct?: number;
  claims_within_20pct?: number;
  cost_per_claim_usd?: number;
  median_latency_s?: number;
  price_is_estimate?: boolean;
  structural?: { tp: number; fp: number; fn: number; tn: number };
  unusable_photos_caught?: string;
  usable_photos_wrongly_rejected?: string;
  errors_by_confidence?: Record<string, { findings: number; wrong: number; error_rate: number }>;
  per_claim?: EvalPerClaim[];
}

export interface EvalPayload {
  available: boolean;
  generated_at?: string;
  dataset?: Record<string, string | number>;
  notes?: string[];
  results?: EvalResult[];
  single_run?: EvalResult[];
  ai_labelling?: {
    available?: boolean;
    method?: string;
    agreement_with_human?: Record<string, unknown>;
    results?: EvalResult[];
  };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, { credentials: "same-origin", ...init, headers: { ...(init?.headers ?? {}), "X-Role": currentRole } });
  } catch {
    throw new ApiError(0, "The server can't be reached. Check the connection and try again.");
  }
  if (resp.status === 401) {
    window.location.assign("/login");
    throw new ApiError(401, "Sign in first.");
  }
  if (!resp.ok) {
    let message = `The request failed (${resp.status}).`;
    try {
      const body = await resp.json();
      if (typeof body?.detail === "string") message = body.detail;
      else if (Array.isArray(body?.detail) && body.detail[0]?.msg) message = String(body.detail[0].msg);
    } catch {
      /* keep the default message */
    }
    throw new ApiError(resp.status, message);
  }
  return (await resp.json()) as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export interface FindingPatch {
  part?: string;
  side?: string;
  damage_type?: string;
  severity?: string;
  operation_override?: string;
  price_override?: number;
  reason_code: string;
  note: string;
}

export interface FindingNew {
  part: string;
  side: string;
  damage_type: string;
  severity: string;
  photo_id?: string;
  reason_code: string;
  note: string;
}

export type DecisionAction = "approve" | "reject" | "request_info" | "reopen" | "send_for_approval" | "send_back";

export const api = {
  reference: () => request<Reference>("/api/reference"),
  usage: () => request<Usage>("/api/usage"),
  claims: () => request<ClaimSummary[]>("/api/claims"),
  claim: (id: string) => request<ClaimView>(`/api/claims/${encodeURIComponent(id)}`),
  editFinding: (id: string, fid: string, body: FindingPatch) =>
    request<ClaimView>(`/api/claims/${encodeURIComponent(id)}/findings/${encodeURIComponent(fid)}`, json("PATCH", body)),
  addFinding: (id: string, body: FindingNew) => request<ClaimView>(`/api/claims/${encodeURIComponent(id)}/findings`, json("POST", body)),
  removeFinding: (id: string, fid: string, reasonCode: string, note: string) =>
    request<ClaimView>(
      `/api/claims/${encodeURIComponent(id)}/findings/${encodeURIComponent(fid)}?reason_code=${encodeURIComponent(reasonCode)}&note=${encodeURIComponent(note)}`,
      { method: "DELETE" },
    ),
  decide: (id: string, body: { action: DecisionAction; shop_id?: string | null; note?: string }) =>
    request<ClaimView>(`/api/claims/${encodeURIComponent(id)}/decision`, json("POST", body)),
  assess: (id: string) => request<ClaimView>(`/api/claims/${encodeURIComponent(id)}/assess`, { method: "POST" }),
  samples: () => request<Sample[]>("/api/samples"),
  tryIt: (form: FormData) => request<{ id: string }>("/api/try", { method: "POST", body: form }),
  evaluation: () => request<EvalPayload>("/api/eval"),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (body: Partial<Settings>) => request<Settings>("/api/settings", json("PUT", body)),
  priceTable: () => request<PriceRow[]>("/api/price-table"),
  corrections: () => request<Correction[]>("/api/corrections"),
  logout: () => request<{ ok: boolean }>("/api/logout", { method: "POST" }),
};
