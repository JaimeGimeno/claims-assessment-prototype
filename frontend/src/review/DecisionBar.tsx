import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, CornerUpLeft, Printer, RotateCcw, Send } from "lucide-react";
import { api } from "../api";
import type { ClaimView, DecisionAction } from "../api";
import { useApp } from "../app-context";
import { dateTime, money, range } from "../format";
import { Button, cx, ErrorNote, Field, inputClass, Modal, RouteChip, SampleTag, StatusChip } from "../ui";

type Action = DecisionAction;
type Dialog = "reject" | "request_info" | "send_back";

export default function DecisionBar({ view, onChange }: { view: ClaimView; onChange: (v: ClaimView) => void }) {
  const { reference, role } = useApp();
  const needsStructural = Boolean(view.flags.structural);
  const fast = view.route === "fast_track";
  const defaultShop = fast ? (reference.shops[0]?.id ?? "") : "";
  const [shop, setShop] = useState(defaultShop);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    setShop(defaultShop);
    setError(null);
  }, [view.id, defaultShop]);

  const act = async (action: Action, body: { shop_id?: string; note?: string } = {}) => {
    setBusy(action);
    setError(null);
    try {
      const v = await api.decide(view.id, { action, ...body });
      setDialog(null);
      onChange(v);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openDialog = (kind: Dialog) => {
    setError(null);
    setNote(kind === "request_info" ? view.routing.info_requests.join("\n") : "");
    setDialog(kind);
  };

  const t = view.estimate.totals;
  const status = view.review.status;
  const shopName = reference.shops.find((s) => s.id === view.review.shop_id);
  const noLines = view.findings.length === 0;
  const infoFirst = view.route === "need_more_information";
  const senior = role === "senior";
  const checked = status === "agent_checked";
  const open = status === "pending" || checked;
  // The senior adjuster decides. The agent only acts on a claim that is waiting for a check.
  const seniorActs = senior && open;
  const agentActs = !senior && status === "pending";
  const canReopen = senior || status === "info_requested" || checked;

  return (
    <div className="no-print sticky bottom-0 z-20 border-t border-line-strong bg-surface shadow-[0_-4px_16px_rgb(27_27_25/0.06)]">
      <div className="mx-auto max-w-[1560px] px-6 py-2.5">
        {error && !dialog ? <ErrorNote className="mb-2">{error}</ErrorNote> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="mr-auto flex min-w-0 items-center gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-xs text-muted">
                Estimate <SampleTag>Sample</SampleTag>
              </div>
              <div className="num text-base leading-6 font-semibold whitespace-nowrap">
                {noLines ? "No lines" : t.is_range ? range(t.low, t.high) : money(t.total)}
              </div>
            </div>
            <span className="hidden xl:inline-flex">
              <RouteChip route={view.route} name={view.route_name} />
            </span>
          </div>

          {seniorActs ? (
            <>
              <label className="flex items-center gap-2 text-[13px]">
                <span className="hidden text-muted xl:inline">Shop</span>
                <select
                  value={shop}
                  onChange={(e) => setShop(e.target.value)}
                  className={cx(inputClass, "w-[210px] xl:w-[260px]")}
                  aria-label="Shop to authorise"
                  disabled={noLines}
                >
                  <option value="">Choose a shop to authorise</option>
                  {reference.shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}, {s.city}
                      {s.structural ? " (structural work)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant={infoFirst ? "secondary" : "primary"}
                icon={<Check size={15} />}
                busy={busy === "approve"}
                disabled={!shop || noLines || busy !== null}
                title={noLines ? "There is nothing to authorise: the estimate has no lines" : !shop ? "Choose a shop first" : undefined}
                onClick={() => act("approve", { shop_id: shop })}
              >
                Approve and authorise
              </Button>
              {checked ? (
                <Button icon={<CornerUpLeft size={14} />} disabled={busy !== null} onClick={() => openDialog("send_back")}>
                  Send back to agent
                </Button>
              ) : (
                <Button variant={infoFirst ? "primary" : "secondary"} disabled={busy !== null} onClick={() => openDialog("request_info")}>
                  Request information
                </Button>
              )}
              <Button variant="danger" disabled={busy !== null} onClick={() => openDialog("reject")}>
                Reject
              </Button>
            </>
          ) : agentActs ? (
            <>
              {fast ? (
                <span className="text-[13px] text-muted">Fast-track: no agent check needed.</span>
              ) : (
                <Button
                  variant={infoFirst ? "secondary" : "primary"}
                  icon={<Send size={14} />}
                  busy={busy === "send_for_approval"}
                  disabled={noLines || busy !== null}
                  title={noLines ? "There is nothing to approve: the estimate has no lines" : undefined}
                  onClick={() => act("send_for_approval")}
                >
                  Checked: send to senior adjuster
                </Button>
              )}
              <Button variant={infoFirst ? "primary" : "secondary"} disabled={busy !== null} onClick={() => openDialog("request_info")}>
                Request information
              </Button>
            </>
          ) : (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                <StatusChip status={status} route={view.route} />
                {shopName ? (
                  <span>
                    Authorised: <span className="font-medium">{shopName.name}</span>, {shopName.city}
                  </span>
                ) : null}
                <span className="num text-muted">{dateTime(view.review.decided_at)}</span>
                {view.review.note ? (
                  <span className="max-w-[420px] truncate text-muted" title={view.review.note}>
                    “{view.review.note}”
                  </span>
                ) : null}
              </div>
              <Link to={`/claims/${view.id}/report`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line-strong px-3.5 text-sm font-medium hover:bg-subtle">
                <Printer size={15} /> Print estimate
              </Link>
              {canReopen ? (
                <Button icon={<RotateCcw size={14} />} busy={busy === "reopen"} onClick={() => act("reopen")}>
                  {checked ? "Take back" : "Reopen"}
                </Button>
              ) : null}
            </>
          )}
        </div>
        {seniorActs && needsStructural && shop && !reference.shops.find((s) => s.id === shop)?.structural ? (
          <p className="mt-1.5 text-right text-xs text-warn">This claim may have structural damage, and this shop isn't marked for structural work.</p>
        ) : null}
        {seniorActs && fast && !checked && !noLines ? (
          <p className="mt-1.5 text-right text-xs text-muted">Fast-track: a shop is preselected, so approving takes one click.</p>
        ) : null}
        {seniorActs && !fast && !checked ? (
          <p className="mt-1.5 text-right text-xs text-warn">A claims agent hasn't checked this claim yet.</p>
        ) : null}
        {!senior && !open && status !== "info_requested" ? (
          <p className="mt-1.5 text-right text-xs text-muted">The senior adjuster decided this claim. Only they can reopen it.</p>
        ) : null}
      </div>

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === "reject" ? `Reject ${view.id}` : dialog === "send_back" ? `Send ${view.id} back to the claims agent` : `Request more information for ${view.id}`}
        width={520}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy !== null}>
              Cancel
            </Button>
            {dialog === "reject" ? (
              <Button variant="danger" busy={busy === "reject"} onClick={() => act("reject", { note })}>
                Reject claim
              </Button>
            ) : dialog === "send_back" ? (
              <Button variant="primary" busy={busy === "send_back"} onClick={() => act("send_back", { note })}>
                Send back
              </Button>
            ) : (
              <Button variant="primary" busy={busy === "request_info"} onClick={() => act("request_info", { note })}>
                Mark as information requested
              </Button>
            )}
          </>
        }
      >
        <Field
          label={dialog === "reject" ? "Reason (optional)" : dialog === "send_back" ? "What should the agent check again?" : "What to ask the policyholder"}
          hint={
            dialog === "request_info"
              ? view.routing.info_requests.length
                ? "Prefilled from what the AI and the routing rules asked for. Edit it freely. Nothing is sent from this prototype."
                : "Nothing is sent from this prototype; the note is saved with the claim."
              : dialog === "send_back"
                ? "The agent sees this note at the top of the claim."
                : "Saved with the claim and shown in the change log."
          }
        >
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5} maxLength={1000} className={cx(inputClass, "h-auto py-2 leading-normal")} autoFocus />
        </Field>
        {error && dialog ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
      </Modal>
    </div>
  );
}
