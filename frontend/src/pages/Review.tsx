import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { AlertTriangle, ArrowLeft, Check, CircleHelp, Printer, RefreshCw } from "lucide-react";
import { api, ApiError } from "../api";
import type { ClaimView, Finding, Role } from "../api";
import { useApp } from "../app-context";
import { carName, dateTime, money, ROLE_NAMES } from "../format";
import { Button, Card, CardHeader, Chip, cx, ErrorNote, FlagChips, LoadingBlock, Modal, SampleTag, StatusChip, useElapsed } from "../ui";
import PhotoViewer from "../review/PhotoViewer";
import FindingsTable from "../review/FindingsTable";
import EstimateSummary from "../review/EstimateSummary";
import ReferencePanel from "../review/ReferencePanel";
import DecisionBar from "../review/DecisionBar";
import ChangeLog from "../review/ChangeLog";

const ROUTE_STYLE: Record<string, string> = {
  fast_track: "border-ok/25 bg-ok-soft/60",
  full_review: "border-warn/25 bg-warn-soft/60",
  need_more_information: "border-info/25 bg-info-soft/70",
};
const ROUTE_TEXT: Record<string, string> = { fast_track: "text-ok", full_review: "text-warn", need_more_information: "text-info" };
const ROUTE_LEAD: Record<string, string> = {
  fast_track: "Goes straight to the senior adjuster.",
  full_review: "A claims agent checks the draft, then the senior adjuster approves.",
  need_more_information: "Can't be assessed yet. The claims agent asks the policyholder for more.",
};

/** What the person viewing has to do on this claim, in one or two sentences. */
function nextStep(view: ClaimView, role: Role): { mine: boolean; text: string; note?: string } {
  const st = view.review.status;
  const route = view.route;
  const senior = role === "senior";
  if (st === "approved" || st === "rejected") {
    return { mine: false, text: senior ? "This claim has a decision. Reopen it to change anything." : "The senior adjuster has decided this claim." };
  }
  if (st === "info_requested") {
    return { mine: false, text: "Waiting for the policyholder. When the new photos arrive, reopen the claim and run the AI again.", note: view.review.note || undefined };
  }
  if (st === "agent_checked") {
    const n = view.corrections.filter((c) => c.actor === "agent" && ["edit", "add", "remove"].includes(c.action)).length;
    const did = n === 0 ? "and changed nothing" : `and made ${n} ${n === 1 ? "change" : "changes"}, listed in the change log`;
    return senior
      ? { mine: true, text: `A claims agent has checked this draft ${did}. Look over the estimate, choose a shop and approve. Send it back if something needs another look.` }
      : { mine: false, text: "You sent this to the senior adjuster, who approves it. Take it back if you need to change something." };
  }
  if (!route) return { mine: !senior, text: "This claim hasn't been assessed yet. Run the AI first." };
  if (route === "fast_track") {
    return senior
      ? { mine: true, text: "Take a quick look at the photos and the estimate, then approve. A shop is preselected, so it takes one click." }
      : { mine: false, text: "Fast-track claims go straight to the senior adjuster. There is nothing for you to check." };
  }
  // the latest hand-over tells whether the senior adjuster sent it back
  const last = view.corrections.find((c) => c.action === "send_back" || c.action === "send_for_approval");
  const back = last?.action === "send_back" ? last.note || "No note given." : undefined;
  if (route === "need_more_information") {
    return senior
      ? { mine: false, text: "With the claims agent, who asks the policyholder for what's missing. It can't be approved from these photos." }
      : { mine: true, text: "Ask the policyholder for what's missing, using the list below. The estimate can't be trusted until then." };
  }
  return senior
    ? { mine: false, text: "With the claims agent, who checks the AI's draft first. It reaches your queue when they send it. You can still check it yourself and decide." }
    : {
        mine: true,
        text: "Check each finding against the photos, starting with the reasons below. Correct, add or remove damage, then send the claim to the senior adjuster.",
        note: back ? `Sent back by the senior adjuster: ${back}` : undefined,
      };
}

function NextStep({ view }: { view: ClaimView }) {
  const { role } = useApp();
  const step = nextStep(view, role);
  return (
    <section className={cx("rounded-lg border px-4 py-3", step.mine ? "border-ink bg-surface" : "border-line bg-subtle")}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="text-[13px] font-semibold whitespace-nowrap">
          {step.mine ? `Your step as ${ROLE_NAMES[role].toLowerCase()}` : `No step for the ${ROLE_NAMES[role].toLowerCase()} right now`}
        </h2>
        <p className={cx("text-[13px]", step.mine ? "" : "text-muted")}>{step.text}</p>
      </div>
      {step.note ? <p className="mt-1.5 text-[13px] font-medium text-warn">{step.note}</p> : null}
    </section>
  );
}

function RouteBanner({ view }: { view: ClaimView }) {
  const r = view.routing;
  const key = r.route ?? "";
  return (
    <section className={cx("rounded-lg border px-4 py-3", ROUTE_STYLE[key] ?? "border-line bg-surface")}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 className={cx("text-base font-semibold", ROUTE_TEXT[key])}>{view.route_name}</h2>
        <FlagChips flags={view.flags} />
        <span className="text-[13px] text-muted">{ROUTE_LEAD[key] ?? ""}</span>
      </div>
      {view.assessment && view.assessment.status !== "ok" ? (
        <ErrorNote className="mt-2">
          <span className="font-medium">The AI assessment failed.</span> {view.assessment.error || ""} You can build the estimate by hand with “Add damage”, or
          run the AI again.
        </ErrorNote>
      ) : null}
      <ul className="mt-2 space-y-1 text-[13px]">
        {r.reasons.map((x, i) => (
          <li key={i} className="flex gap-2">
            <span className={cx("mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current", ROUTE_TEXT[key])} aria-hidden />
            <span>{x.text}</span>
          </li>
        ))}
      </ul>
      {r.notes?.length ? <p className="mt-2 text-[13px] text-muted">{r.notes.join(" ")}</p> : null}
      {r.info_requests.length ? (
        <div className="mt-2.5 border-t border-ink/10 pt-2.5 text-[13px]">
          <div className="font-medium">{r.route === "need_more_information" ? "What to ask for" : "The AI would also ask for"}</div>
          <ul className="mt-1 list-decimal space-y-0.5 pl-5">
            {r.info_requests.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-2.5 text-xs text-muted">The route comes from fixed rules and the limits in Settings. The AI never approves anything.</p>
    </section>
  );
}

type CheckState = "ok" | "warn" | "bad" | "unknown";

function CheckItem({ state, label, detail }: { state: CheckState; label: string; detail?: ReactNode }) {
  const icon =
    state === "ok" ? (
      <Check size={14} className="text-ok" aria-label="OK" />
    ) : state === "unknown" ? (
      <CircleHelp size={14} className="text-faint" aria-label="Unknown" />
    ) : (
      <AlertTriangle size={14} className={state === "bad" ? "text-bad" : "text-warn"} aria-label="Attention" />
    );
  return (
    <div className="min-w-0 bg-surface px-4 py-2.5">
      <div className="flex items-start gap-1.5 text-[13px] font-medium [&>svg]:mt-[3px] [&>svg]:shrink-0">
        {icon}
        {label}
      </div>
      {detail ? <div className="mt-0.5 text-xs text-muted">{detail}</div> : null}
    </div>
  );
}

function Checks({ view, onRun }: { view: ClaimView; onRun: () => void }) {
  const { name } = useApp();
  const a = view.assessment;
  const usable = view.photo_list.filter((p) => p.usable).length;
  const total = view.photo_list.length;
  const vc = a?.vehicle_check;
  const dc = a?.description_check;
  const ok = a?.status === "ok";

  const vehicle: [CheckState, string, ReactNode] = !ok
    ? ["unknown", "Car match not checked", null]
    : view.vehicle.assumed
      ? ["ok", "Policy car drafted by the AI", "For a try-out the AI drafts the policy car from these photos, so they match it by construction. On a real claim the photos are checked against the policy record."]
    : vc?.match === "yes"
      ? ["ok", "Car matches the policy", vc.seen ? `Seen: ${vc.seen}` : null]
      : vc?.match === "no"
        ? ["bad", "Car doesn't match the policy", vc.reason || (vc.seen ? `Seen: ${vc.seen}` : null)]
        : vc?.match === "uncertain"
          ? ["warn", "Car match uncertain", `The two AI runs disagree.${vc.seen ? ` Seen: ${vc.seen}` : ""}`]
          : ["unknown", "Can't confirm the car", `The photos don't show enough to compare with the policy.${vc?.seen ? ` Seen: ${vc.seen}` : ""}`];

  const desc: [CheckState, string, ReactNode] = !ok
    ? ["unknown", "Description not checked", null]
    : dc?.consistent === "yes"
      ? ["ok", "Description is consistent", "The damage fits the accident description."]
      : dc?.consistent === "no"
        ? ["bad", "Description doesn't fit", dc.reason || null]
        : dc?.consistent === "not_provided"
          ? ["unknown", "No accident description", "Nothing to compare the damage with."]
          : ["unknown", "Description can't be checked", "The AI couldn't tell from the photos."];

  return (
    <Card>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-t-lg bg-line xl:grid-cols-4">
        <CheckItem
          state={total === 0 ? "unknown" : usable === total ? "ok" : usable === 0 ? "bad" : "warn"}
          label={`Photos usable: ${usable} of ${total}`}
          detail={usable === total ? "All photos could be assessed." : "Unusable photos are marked in the viewer and left out."}
        />
        <CheckItem state={vehicle[0]} label={vehicle[1]} detail={vehicle[2]} />
        <CheckItem state={desc[0]} label={desc[1]} detail={desc[2]} />
        <CheckItem
          state={!ok ? "unknown" : a?.structural_suspected ? "bad" : "ok"}
          label={!ok ? "Structural damage not checked" : a?.structural_suspected ? "Structural damage suspected" : "No structural damage suspected"}
          detail={
            ok ? (
              <>
                {a?.structural_runs ? `Flagged in ${a.structural_runs} AI runs. ` : ""}
                {a?.structural_suspected ? a.structural_reason : ""}
              </>
            ) : null
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-4 py-2 text-xs text-muted">
        {a ? (
          <>
            <span className="font-medium text-ink">{name("models", a.model)}</span>
            {a.n_runs ? <span>{a.n_runs} runs, merged</span> : null}
            <span className="num">{dateTime(a.assessed_at)}</span>
            {a.cost_usd != null ? <span className="num">AI cost ${a.cost_usd.toFixed(3)}</span> : null}
            {a.latency_s != null ? <span className="num">{a.latency_s.toFixed(1)} s</span> : null}
            <Chip tone={a.live ? "accent" : "plain"} title={a.live ? "This result came from a live AI run" : "This result was computed earlier and stored, so opening the claim costs nothing"}>
              {a.live ? "Run live" : "Stored result"}
            </Chip>
          </>
        ) : (
          <span>This claim hasn't been assessed yet.</span>
        )}
        <Button size="sm" className="ml-auto" icon={<RefreshCw size={13} />} onClick={onRun}>
          Run AI live
        </Button>
      </div>
    </Card>
  );
}

function RunLiveDialog({ view, open, onClose, onDone }: { view: ClaimView; open: boolean; onClose: () => void; onDone: (v: ClaimView) => void }) {
  const { refreshUsage, usage, name } = useApp();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const elapsed = useElapsed(running);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const v = await api.assess(view.id);
      onDone(v);
    } catch (e) {
      const err = e as ApiError;
      setError(err.status === 429 ? err.message : `The live run didn't finish. ${err.message}`);
    } finally {
      setRunning(false);
      refreshUsage();
    }
  };
  const n = view.photo_list.length;
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!running) onClose();
      }}
      title="Run the AI live on this claim"
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button variant="primary" busy={running} onClick={run}>
            {running ? `Running, ${elapsed} s` : "Run AI live"}
          </Button>
        </>
      }
    >
      <div className="space-y-2.5 text-[13px]">
        <p>
          {name("models", view.settings.model)} reads {n === 1 ? "the photo" : `all ${n} photos`} again, twice, and the two runs are merged. It takes 5 to 20
          seconds and costs a few cents.
        </p>
        {view.edited || view.corrections.length ? (
          <p className="rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-warn">
            <span className="font-medium">Your edits on this claim will be replaced</span> by the new result. The change log is kept.
          </p>
        ) : (
          <p className="text-muted">The current findings are replaced by the new result.</p>
        )}
        {usage ? (
          <p className="num text-muted">
            Live AI runs today: {usage.live_runs_today} of {usage.daily_cap}.
          </p>
        ) : null}
        {running ? (
          <div role="status" className="space-y-1.5">
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div className="h-1 rounded-full bg-ink transition-[width] duration-1000 ease-linear" style={{ width: `${Math.min(95, (elapsed / 20) * 100)}%` }} />
            </div>
            <p className="text-muted">The AI is reading the photos. Keep this window open.</p>
          </div>
        ) : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </Modal>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-[13px]">{children}</dd>
    </div>
  );
}

export default function Review() {
  const { id = "" } = useParams();
  const { name, role } = useApp();
  const [view, setView] = useState<ClaimView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);

  const load = () => {
    setError(null);
    api.claim(id).then(setView).catch((e: Error) => setError(e.message));
  };
  useEffect(() => {
    setView(null);
    setPhoto(null);
    setSelected(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of view?.findings ?? []) if (f.photo_id) out[f.photo_id] = (out[f.photo_id] ?? 0) + 1;
    return out;
  }, [view]);

  if (error) {
    return (
      <div className="mx-auto max-w-[1560px] px-6 py-5">
        <BackLink />
        <ErrorNote onRetry={load} className="mt-3">
          {error}
        </ErrorNote>
      </div>
    );
  }
  if (!view) return <LoadingBlock label="Loading the claim" />;

  const currentPhoto = photo && view.photo_list.some((p) => p.id === photo) ? photo : (view.photo_list[0]?.id ?? null);
  const selectedFinding = view.findings.find((f) => f.id === selected) ?? null;
  const selectFinding = (f: Finding) => {
    setSelected(f.id);
    if (f.photo_id && view.photo_list.some((p) => p.id === f.photo_id)) setPhoto(f.photo_id);
  };
  const st = view.review.status;
  // The agent works on a claim until they send it; the senior adjuster can still edit a checked claim.
  const locked = !(st === "pending" || (st === "agent_checked" && role === "senior"));
  const lockedText =
    st === "agent_checked" ? "You sent this claim for approval. Take it back to change the estimate." : undefined;
  const c = view.claim;
  const isTry = view.id.startsWith("TRY-");

  return (
    <>
      <div className="mx-auto max-w-[1560px] px-6 pt-4 pb-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <BackLink />
          <Link to={`/claims/${view.id}/report`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-subtle">
            <Printer size={14} /> Print estimate
          </Link>
        </div>

        <Card className="mb-4 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="num text-xl font-semibold tracking-[-0.01em]">{view.id}</h1>
            <StatusChip status={view.review.status} route={view.route} />
            {isTry ? <Chip tone="accent">Created in Try it</Chip> : null}
            {view.edited ? <Chip tone="plain">Edited by a person</Chip> : null}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-[1.3fr_1.3fr_0.8fr_0.6fr_0.8fr] xl:grid-cols-[1fr_1.2fr_0.8fr_0.7fr_0.7fr_2.4fr]">
            <Fact label="Policyholder">
              {view.policyholder || "–"}
              {view.policy_number ? <span className="num text-muted"> · {view.policy_number}</span> : null}
            </Fact>
            <Fact label="Car">
              {carName(view.vehicle)}
              {view.vehicle.color ? <span className="text-muted">, {view.vehicle.color}</span> : null}
              <div className="text-xs text-muted">{name("vehicle_classes", view.vehicle.vehicle_class)}</div>
              {view.vehicle.assumed ? <div className="mt-0.5 text-xs text-muted">Sample policy drafted by the AI from the photos. On a real claim this comes from the policy record.</div> : null}
            </Fact>
            <Fact label="Car value">
              <span className="num font-medium">{money(view.vehicle.value)}</span>
              <div className="mt-0.5">
                <SampleTag />
              </div>
            </Fact>
            <Fact label="Drivable">{c.drivable === false ? <span className="font-medium text-bad">No</span> : "Yes"}</Fact>
            <Fact label="Airbags">{c.airbags_deployed ? <span className="font-medium text-bad">Deployed</span> : "Not deployed"}</Fact>
            <div className="col-span-2 md:col-span-5 xl:col-span-1">
              <Fact label="Accident description">
                {c.accident_description ? <span>{c.accident_description}</span> : <span className="text-muted">None given.</span>}
              </Fact>
            </div>
          </dl>
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(320px,36%)_minmax(0,1fr)] xl:grid-cols-[minmax(330px,38%)_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-16">
            <PhotoViewer
              photos={view.photo_list}
              current={currentPhoto}
              onSelect={(pid) => {
                setPhoto(pid);
                setSelected(null);
              }}
              counts={counts}
              caption={selectedFinding && selectedFinding.photo_id === currentPhoto ? `${selectedFinding.part_name}${selectedFinding.side === "left" || selectedFinding.side === "right" ? `, ${selectedFinding.side}` : ""}` : null}
            />
          </div>
          <div className="min-w-0 space-y-4">
            <NextStep view={view} />
            <RouteBanner view={view} />
            <Checks view={view} onRun={() => setRunOpen(true)} />
            <FindingsTable view={view} selected={selected} onSelect={selectFinding} onChange={setView} currentPhoto={currentPhoto} locked={locked} lockedText={lockedText} />
            <EstimateSummary view={view} />
            {view.reference ? <ReferencePanel data={view.reference} /> : null}
            <Card>
              <CardHeader title="Change log" sub="Every edit needs a reason and records who made it, so the corrections can be used to improve the AI." />
              <ChangeLog rows={view.corrections} />
            </Card>
          </div>
        </div>
      </div>

      <DecisionBar view={view} onChange={setView} />
      <RunLiveDialog
        view={view}
        open={runOpen}
        onClose={() => setRunOpen(false)}
        onDone={(v) => {
          setRunOpen(false);
          setSelected(null);
          setView(v);
        }}
      />
    </>
  );
}

function BackLink() {
  return (
    <Link to="/" className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-muted hover:text-ink">
      <ArrowLeft size={14} /> Claims
    </Link>
  );
}
