import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, X } from "lucide-react";
import { api } from "../api";
import type { ClaimSummary, Role } from "../api";
import { useApp } from "../app-context";
import { carName, claimEstimate, money, pct, ROLE_NAMES } from "../format";
import { Card, Chip, cx, Empty, ErrorNote, FlagChips, inputClass, LoadingBlock, PageHeader, RouteChip, SampleTag, StatusChip, th, thNum } from "../ui";

type RouteFilter = "all" | "fast_track" | "full_review" | "need_more_information";
type Tab = "todo" | "other" | "policyholder" | "decided" | "all";

const ROUTES: { id: RouteFilter; label: string }[] = [
  { id: "all", label: "All routes" },
  { id: "fast_track", label: "Fast-track" },
  { id: "full_review", label: "Full review" },
  { id: "need_more_information", label: "Need more information" },
];

const ROLE_INTRO: Record<Role, string> = {
  agent:
    "You check the AI's draft on claims that need a full review, then send them to the senior adjuster. You also ask policyholders for missing information. Fast-track claims skip you.",
  senior:
    "You approve every repair and authorise the shop. Fast-track claims come straight to you and take one click. Full-review claims reach you after a claims agent has checked them.",
};

function tabOf(c: ClaimSummary, role: Role): Tab {
  if (c.owner === null) return "decided";
  if (c.owner === "policyholder") return "policyholder";
  return c.owner === role ? "todo" : "other";
}

/** One line of the "how a claim moves" card. The current role's step is in dark text. */
function FlowRow({ route, name, steps, role }: { route: string; name: string; steps: { who: Role | "ai" | "policyholder"; text: string }[]; role: Role }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      <span className="w-[168px] shrink-0">
        <RouteChip route={route as ClaimSummary["route"]} name={name} />
      </span>
      {steps.map((st, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 ? <ArrowRight size={13} className="text-faint" aria-hidden /> : null}
          <span className={st.who === role ? "font-medium text-ink" : "text-muted"}>{st.text}</span>
        </span>
      ))}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1 px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-0.5 text-[22px] leading-7 font-semibold tracking-[-0.01em]">{value}</div>
      {note ? <div className="mt-0.5 text-xs text-muted">{note}</div> : null}
    </div>
  );
}

function Thumbs({ photos }: { photos: string[] }) {
  const shown = photos.slice(0, 3);
  const more = photos.length - shown.length;
  return (
    <div className="flex items-center gap-1">
      {shown.map((p) => (
        <img key={p} src={`/photos/${p}?w=160`} alt="" loading="lazy" className="h-9 w-12 rounded-sm border border-line bg-subtle object-cover" />
      ))}
      {more > 0 ? <span className="num pl-0.5 text-xs text-muted">+{more}</span> : null}
    </div>
  );
}

/** A short introduction for a first-time visitor: what the prototype does and what to try. */
function StartHere({ onHide }: { onHide: () => void }) {
  const steps: { title: string; text: React.ReactNode }[] = [
    {
      title: "1. Approve a fast-track claim",
      text: "As senior adjuster, open a claim from your queue, look at the photos and the estimate, and approve it in one click.",
    },
    {
      title: "2. Check a full-review claim",
      text: "Switch to claims agent at the top right. Open a claim, correct a finding and send it on. Switch back to approve it.",
    },
    {
      title: "3. Try your own photo",
      text: (
        <>
          Go to{" "}
          <Link to="/try" className="font-medium text-accent underline underline-offset-2">
            Try it
          </Link>
          , upload a photo of a damaged car, and get the findings, estimate and route in about 10 seconds.
        </>
      ),
    },
  ];
  return (
    <Card className="mb-4 border-ink px-4 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">Start here</h2>
          <p className="mt-1 max-w-[105ch] text-[13px]">
            This prototype handles a car insurance claim from the damage photos to the repair authorisation. The AI reads the photos and lists what is
            damaged. Fixed rules price each part from a cost table and pick a route. A person approves every repair. It replaces the manual photo review
            and the first estimate; the senior adjuster's approval stays.
          </p>
        </div>
        <button type="button" onClick={onHide} className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-medium text-muted hover:text-ink">
          <X size={13} aria-hidden /> Hide
        </button>
      </div>
      <div className="mt-3 grid gap-x-6 gap-y-3 md:grid-cols-3">
        {steps.map((st) => (
          <div key={st.title} className="min-w-0 border-t border-line pt-2.5">
            <div className="text-[13px] font-semibold">{st.title}</div>
            <p className="mt-0.5 text-[13px] text-muted">{st.text}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">
        The photos are real. Prices, car values and policyholders are sample data. How the AI did on 24 test claims is under{" "}
        <Link to="/evaluation" className="font-medium text-ink underline underline-offset-2">
          Evaluation
        </Link>
        , and the routing limits are under{" "}
        <Link to="/settings" className="font-medium text-ink underline underline-offset-2">
          Settings
        </Link>
        .
      </p>
    </Card>
  );
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readSaved(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export default function Queue() {
  const [claims, setClaims] = useState<ClaimSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The filters are remembered for the browser session, so coming back from a claim
  // returns to the same filtered list.
  const { role } = useApp();
  const other: Role = role === "agent" ? "senior" : "agent";
  const [route, setRoute] = useState<RouteFilter>(() => (readSaved("claims.route") as RouteFilter) || "all");
  const [tab, setTab] = useState<Tab>(() => (readSaved("claims.tab") as Tab) || "todo");
  useEffect(() => {
    try {
      sessionStorage.setItem("claims.route", route);
      sessionStorage.setItem("claims.tab", tab);
    } catch {
      // storage can be unavailable in private windows; the filters still work for this visit
    }
  }, [route, tab]);
  // Switching role shows that person's queue, without a leftover route filter hiding it.
  const [shownRole, setShownRole] = useState(role);
  if (shownRole !== role) {
    setShownRole(role);
    setTab("todo");
    setRoute("all");
  }
  const nav = useNavigate();
  // The introduction shows until the visitor hides it; the choice is kept in this browser.
  const [intro, setIntro] = useState(() => readLocal("claims.intro") !== "hidden");
  const showIntro = (on: boolean) => {
    setIntro(on);
    try {
      localStorage.setItem("claims.intro", on ? "shown" : "hidden");
    } catch {
      // storage can be unavailable in private windows; the choice still holds for this visit
    }
  };

  const load = () => {
    setError(null);
    api.claims().then(setClaims).catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const ordered = useMemo(() => {
    if (!claims) return [];
    // sample claims first, then the ones a visitor made in "Try it" (newest first)
    return [...claims].sort((a, b) => Number(b.sample) - Number(a.sample) || (a.sample ? a.id.localeCompare(b.id) : (b.created_at ?? 0) - (a.created_at ?? 0)));
  }, [claims]);

  const byRoute = useMemo(() => ordered.filter((c) => route === "all" || c.route === route), [ordered, route]);
  const rows = useMemo(() => byRoute.filter((c) => tab === "all" || tabOf(c, role) === tab), [byRoute, tab, role]);
  const counts = useMemo(() => {
    const out: Record<string, number> = { all: byRoute.length };
    for (const c of byRoute) {
      const t = tabOf(c, role);
      out[t] = (out[t] ?? 0) + 1;
    }
    return out;
  }, [byRoute, role]);
  const tabs: { id: Tab; label: string }[] = [
    { id: "todo", label: "Your queue" },
    { id: "other", label: `With the ${ROLE_NAMES[other].toLowerCase()}` },
    { id: "policyholder", label: "Waiting for the policyholder" },
    { id: "decided", label: "Decided" },
    { id: "all", label: "All claims" },
  ];

  const waiting = ordered.filter((c) => c.owner !== null);
  const mine = ordered.filter((c) => c.owner === role).length;
  const fast = waiting.filter((c) => c.route === "fast_track").length;
  const total = waiting.reduce((s, c) => s + (c.estimate_total || 0), 0);
  const flagged = waiting.filter((c) => c.flags.total_loss || c.flags.structural).length;

  return (
    <div className="mx-auto max-w-[1560px] px-6 py-5">
      <PageHeader
        title={`Claims: ${ROLE_NAMES[role].toLowerCase()} view`}
        sub={
          <>
            {ROLE_INTRO[role]} <span className="text-faint">Switch the view at the top right.</span>
          </>
        }
        aside={
          intro ? null : (
            <button type="button" onClick={() => showIntro(true)} className="text-[13px] font-medium text-muted underline underline-offset-2 hover:text-ink">
              Show the introduction
            </button>
          )
        }
      />

      {intro ? <StartHere onHide={() => showIntro(false)} /> : null}

      {error ? <ErrorNote onRetry={load}>{error}</ErrorNote> : null}
      {!claims && !error ? <LoadingBlock label="Loading claims" /> : null}

      {claims ? (
        <>
          <Card className="mb-4 px-4 py-3">
            <div className="mb-2 text-xs text-muted">
              How a claim moves. The AI reads the photos and drafts the estimate, fixed rules pick the route, and a person approves every repair.
            </div>
            <div className="space-y-1.5">
              <FlowRow
                role={role}
                route="fast_track"
                name="Fast-track"
                steps={[{ who: "senior", text: "Senior adjuster approves in one click and authorises the shop" }]}
              />
              <FlowRow
                role={role}
                route="full_review"
                name="Full review"
                steps={[
                  { who: "agent", text: "Claims agent checks and corrects the AI's draft" },
                  { who: "senior", text: "Senior adjuster approves and authorises the shop" },
                ]}
              />
              <FlowRow
                role={role}
                route="need_more_information"
                name="Need more information"
                steps={[
                  { who: "agent", text: "Claims agent asks the policyholder for what's missing" },
                  { who: "policyholder", text: "Policyholder sends it" },
                ]}
              />
            </div>
          </Card>

          <Card className="mb-4 flex flex-wrap divide-x divide-line">
            <Stat label="In your queue" value={String(mine)} note={`${waiting.length} open claims, ${ordered.length} in total`} />
            <Stat
              label="Fast-track share"
              value={waiting.length ? pct(fast / waiting.length) : "–"}
              note={`${fast} of ${waiting.length} open claims skip the agent`}
            />
            <Stat label="Flagged" value={String(flagged)} note="Possible total loss or structural damage" />
            <Stat label="Total estimated, open claims" value={money(total)} note={<SampleTag>Sample prices</SampleTag>} />
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-3 py-2">
              <div role="tablist" aria-label="Filter by whose turn it is" className="flex flex-wrap gap-1">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    type="button"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={cx(
                      "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                      tab === t.id ? "bg-ink text-white" : "text-muted hover:bg-ink/5 hover:text-ink",
                    )}
                  >
                    {t.label}
                    <span className={cx("num text-xs", tab === t.id ? "text-white/70" : "text-faint")}>{counts[t.id] ?? 0}</span>
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-[13px] text-muted">
                Route
                <select value={route} onChange={(e) => setRoute(e.target.value as RouteFilter)} className={cx(inputClass, "h-8 w-auto pr-7")}>
                  {ROUTES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {rows.length === 0 ? (
              <Empty title={tab === "todo" ? "Nothing in your queue" : "No claims here"}>
                {tab === "todo"
                  ? role === "senior"
                    ? "Full-review claims arrive here once a claims agent has checked them. Switch to the claims agent view to do that step."
                    : "Claims that need a check or an information request arrive here."
                  : "Choose another tab or route to see more claims."}
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[940px] table-fixed border-collapse text-[13px]">
                  <colgroup>
                    <col className="w-[136px]" />
                    <col className="w-[164px]" />
                    <col className="w-[152px]" />
                    <col />
                    <col className="w-[148px]" />
                    <col className="w-[136px]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-line bg-subtle">
                      <th className={th}>Claim</th>
                      <th className={th}>Car</th>
                      <th className={th}>Photos</th>
                      <th className={th}>Route, flags and main reason</th>
                      <th className={thNum}>Estimate</th>
                      <th className={th}>Whose turn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr
                        key={c.id}
                        onClick={() => nav(`/claims/${c.id}`)}
                        className="cursor-pointer border-b border-line last:border-0 hover:bg-subtle"
                      >
                        <td className="px-3 py-2.5 align-top">
                          <Link to={`/claims/${c.id}`} onClick={(e) => e.stopPropagation()} className="num font-semibold hover:underline">
                            {c.id}
                          </Link>
                          <div className="mt-0.5 flex items-center gap-1.5 text-muted">
                            {c.id.startsWith("TRY-") ? <Chip tone="accent">Try it</Chip> : <span className="truncate">{c.policyholder}</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <div className="truncate" title={carName(c.vehicle)}>
                            {carName(c.vehicle)}
                          </div>
                          <div className="num mt-0.5 text-muted">{c.vehicle.value ? `Value ${money(c.vehicle.value)}` : ""}</div>
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <Thumbs photos={c.photos} />
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <div className="flex flex-wrap items-center gap-1">
                            <RouteChip route={c.route} name={c.route_name} />
                            <FlagChips flags={c.flags} />
                            {c.assessment_failed ? <Chip tone="bad">AI failed</Chip> : null}
                            {c.edited ? <Chip tone="plain">Edited</Chip> : null}
                          </div>
                          <div className="mt-1 line-clamp-2 text-muted xl:line-clamp-1" title={c.route_reasons.map((r) => r.text).join("\n")}>
                            {c.route_reasons[0]?.text ?? ""}
                            {c.route_reasons.length > 1 ? <span className="text-faint"> +{c.route_reasons.length - 1} more</span> : null}
                          </div>
                        </td>
                        <td className="num px-3 py-2.5 text-right align-top font-medium whitespace-nowrap">
                          {claimEstimate(c)}
                          <div className="mt-0.5 font-normal text-muted">
                            {c.n_findings} {c.n_findings === 1 ? "damaged part" : "damaged parts"}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <StatusChip status={c.status} route={c.route} short />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="mt-3 text-xs text-muted">
            Sample claims with stored AI results. Prices, labour hours, car values and policyholders are sample data.
          </p>
        </>
      ) : null}
    </div>
  );
}
