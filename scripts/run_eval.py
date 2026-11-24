"""Eval: runs every sample claim through each model, with and without the accident
description, then scores the results against the human-checked labels.

  python scripts/run_eval.py run --models claude-sonnet-5-5 claude-haiku-5-5
  python scripts/run_eval.py score

Raw model answers are cached in data/eval/raw/, so scoring can be redone for free
and a stopped run picks up where it left off. Spend is tracked in data/eval/spend.json
and the run stops at the budget.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import assess, evaluation, refdata, routing, service  # noqa: E402
from backend.config import DATA_DIR, DEFAULT_SETTINGS, MODELS  # noqa: E402
from backend.pricing import build_estimate  # noqa: E402
from backend.providers import ModelError  # noqa: E402

EVAL = DATA_DIR / "eval"
RAW = EVAL / "raw"
SPEND = EVAL / "spend.json"
BUDGET_USD = 28.0
CONDITIONS = ["with_description", "no_description"]


PROMPT_WRITING_USD = 0.75  # calls made while writing the prompt, before results were cached
_spent = None


def recount_spend() -> dict:
    """The saved raw answers are the record of what was spent: each one carries its cost."""
    by_model, by_purpose = {}, {}
    for f in RAW.rglob("*.json"):
        rel = f.relative_to(RAW).parts
        purpose = "ai_labelling" if rel[0] == "_labelling" else ("sample_photo_runs" if rel[1] in ("photo", "vehicle") else "eval")
        model = rel[1] if rel[0] == "_labelling" else rel[0]
        cost = json.loads(f.read_text())["cost_usd"]
        by_model[model] = round(by_model.get(model, 0) + cost, 5)
        by_purpose[purpose] = round(by_purpose.get(purpose, 0) + cost, 5)
    by_purpose["prompt_writing"] = PROMPT_WRITING_USD
    d = {"total": round(sum(by_purpose.values()), 2), "by_model": by_model, "by_purpose": by_purpose,
         "note": "Claude prices are published. Gemini prices are estimates, so that part of the total is approximate."}
    EVAL.mkdir(parents=True, exist_ok=True)
    SPEND.write_text(json.dumps(d, indent=1))
    return d


def spend_total() -> float:
    global _spent
    if _spent is None:
        _spent = recount_spend()["total"]
    return _spent


def add_spend(model: str, cost: float, purpose: str) -> None:
    global _spent
    _spent = spend_total() + cost


def claims() -> list:
    return json.loads((DATA_DIR / "claims.json").read_text())


async def run(models: list, conditions: list, n_runs: int, concurrency: int) -> None:
    sem = asyncio.Semaphore(concurrency)
    photos = {}
    for c in claims():
        photos[c["id"]] = service.load_photos(c["photos"])

    async def one(model, cond, claim, k):
        f = RAW / model / cond / f"{claim['id']}_run{k}.json"
        if f.exists():
            return
        async with sem:
            if spend_total() >= BUDGET_USD:
                print("budget reached, skipping", model, cond, claim["id"])
                return
            jpegs, _ = photos[claim["id"]]
            try:
                r = await assess.run_once(model, claim, jpegs, with_description=(cond == "with_description"))
            except ModelError as e:
                print("FAILED", model, cond, claim["id"], k, e)
                return
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(r))
            add_spend(model, r["cost_usd"], "eval")

    for m in models:
        t0 = time.time()
        await asyncio.gather(*[one(m, cond, c, k) for cond in conditions for c in claims() for k in (1, 2)[:n_runs]])
        print(m, "done in", round(time.time() - t0), "s; spend so far $", spend_total())


# ------------------------------------------------------------------ scoring

def load_runs(model: str, cond: str, claim_id: str) -> list:
    out = []
    for k in (1, 2):
        f = RAW / model / cond / f"{claim_id}_run{k}.json"
        if f.exists():
            out.append(json.loads(f.read_text()))
    return out


def reference_route(claim: dict, ref: dict, cls: str) -> str:
    """The route the rules give when fed the human labels instead of the AI's reading."""
    if ref["all_photos_unusable"]:
        return routing.NEED_INFO
    findings = [dict(f, id=f"r{i}", confidence="high", action="", paint_damaged=True) for i, f in enumerate(ref["findings"]) if not f.get("optional")]
    a = {"status": "ok", "photos": [{"photo_id": p, "usable": True} for p in claim["photos"]], "findings": findings,
         "vehicle_check": {"match": "yes"}, "description_check": {}, "structural_suspected": ref["structural_suspected"]}
    return routing.route_claim(claim, a, findings, build_estimate(findings, cls), DEFAULT_SETTINGS)["route"]


def pct(a, b):
    return round(100 * a / b, 1) if b else None


def score_model(model: str, cond: str, single_run: bool = False) -> dict:
    labels = refdata.human_labels()
    tot = dict(required=0, found=0, extra=0, ai_total=0, matched=0, severity_ok=0, type_ok=0, side_ok=0)
    per_claim, gaps, gap_pct, within20 = [], [], [], 0
    struct = dict(tp=0, fp=0, fn=0, tn=0)
    route_ok = route_n = 0
    photo_bad_caught = photo_bad_total = photo_good_flagged = photo_good_total = 0
    by_conf = {c: dict(n=0, wrong=0) for c in ("high", "medium", "low")}
    costs, lats, n_scored = [], [], 0
    routes = {}
    for claim in claims():
        runs = load_runs(model, cond, claim["id"])
        if not runs:
            continue
        if single_run:
            runs = runs[:1]
        n_scored += 1
        _, gates = service.load_photos(claim["photos"])
        a = assess.merge_runs([r["data"] for r in runs], claim["photos"], gates)
        cls = claim["vehicle"]["vehicle_class"]
        ref = evaluation.claim_reference([labels[p] for p in claim["photos"]])
        cmp = evaluation.compare(a["findings"], ref)
        for k in tot:
            tot[k] += cmp["counts"][k]
        ai_est = build_estimate(a["findings"], cls)
        ai_total = ai_est["totals"]["total"]
        ref_total = evaluation.reference_total(cmp, cls)
        gap = ai_total - ref_total
        gaps.append(abs(gap))
        if ref_total > 0:
            gap_pct.append(abs(gap) / ref_total * 100)
            within20 += abs(gap) / ref_total <= 0.2
        elif ai_total == 0:
            gap_pct.append(0.0)
            within20 += 1
        else:
            gap_pct.append(100.0)
        if not ref["structural_uncertain"]:
            s_ai, s_ref = a["structural_suspected"], ref["structural_suspected"]
            struct["tp" if s_ai and s_ref else "fp" if s_ai else "fn" if s_ref else "tn"] += 1
        r_ai = routing.route_claim(claim, a, a["findings"], ai_est, DEFAULT_SETTINGS)["route"]
        r_ref = reference_route(claim, ref, cls)
        route_n += 1
        route_ok += r_ai == r_ref
        routes[r_ai] = routes.get(r_ai, 0) + 1
        for p in a["photos"]:
            lab = labels[p["photo_id"]]
            if lab.get("photo_unusable") and not lab.get("also_ok_usable"):
                photo_bad_total += 1
                photo_bad_caught += not p["usable"]
            elif not lab.get("photo_unusable"):
                photo_good_total += 1
                photo_good_flagged += not p["usable"]
        for row in cmp["rows"]:
            f = row["ai"]
            if f is None:
                continue
            wrong = row["status"] == "extra" or not row.get("severity_ok", True) or not row.get("type_ok", True)
            by_conf[f["confidence"]]["n"] += 1
            by_conf[f["confidence"]]["wrong"] += wrong
        costs.append(sum(r["cost_usd"] for r in runs))
        lats.append(max(r["latency_s"] for r in runs))
        per_claim.append({
            "claim_id": claim["id"], "car": f"{claim['vehicle']['make']} {claim['vehicle']['model']}", "photos": len(claim["photos"]),
            "required": cmp["counts"]["required"], "found": cmp["counts"]["found"], "extra": cmp["counts"]["extra"],
            "severity_ok": cmp["counts"]["severity_ok"], "matched": cmp["counts"]["matched"],
            "ai_total": ai_total, "reference_total": ref_total, "gap": round(gap, 2), "route_ai": r_ai, "route_reference": r_ref,
            "structural_ai": a["structural_suspected"], "structural_reference": ref["structural_suspected"],
        })
    if not n_scored:
        return {}
    return {
        "model": model, "model_name": MODELS[model]["name"], "condition": cond, "claims": n_scored, "runs_per_claim": 1 if single_run else 2,
        "recall": pct(tot["found"], tot["required"]), "precision": pct(tot["ai_total"] - tot["extra"], tot["ai_total"]),
        "damage_type_accuracy": pct(tot["type_ok"], tot["matched"]), "severity_accuracy": pct(tot["severity_ok"], tot["matched"]),
        "side_accuracy": pct(tot["side_ok"], tot["matched"]),
        "counts": tot,
        "structural": struct,
        "route_agreement": pct(route_ok, route_n), "routes": routes,
        "unusable_photos_caught": f"{photo_bad_caught} of {photo_bad_total}", "usable_photos_wrongly_rejected": f"{photo_good_flagged} of {photo_good_total}",
        "mean_abs_gap_usd": round(statistics.mean(gaps), 0), "median_abs_gap_pct": round(statistics.median(gap_pct), 1),
        "claims_within_20pct": pct(within20, n_scored),
        "errors_by_confidence": {c: {"findings": v["n"], "wrong": v["wrong"], "error_rate": pct(v["wrong"], v["n"])} for c, v in by_conf.items()},
        "cost_per_claim_usd": round(statistics.mean(costs), 4), "median_latency_s": round(statistics.median(lats), 1),
        "price_is_estimate": MODELS[model]["price_is_estimate"],
        "per_claim": per_claim,
    }


def score() -> dict:
    results, single = [], []
    for model in MODELS:
        for cond in CONDITIONS:
            r = score_model(model, cond)
            if r:
                results.append(r)
                s = score_model(model, cond, single_run=True)
                single.append({k: s[k] for k in ("model", "model_name", "condition", "recall", "precision", "severity_accuracy", "claims_within_20pct")})
    labels = refdata.human_labels()
    n_photos = sum(len(c["photos"]) for c in claims())
    summary = {
        "available": bool(results),
        "generated_at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
        "dataset": {
            "claims": len(claims()), "photos": n_photos,
            "required_findings": sum(1 for c in claims() for f in evaluation.claim_reference([labels[p] for p in c["photos"]])["findings"] if not f.get("optional")),
            "labelled_by": "20 public photos: AI draft corrected by a person. 16 own photos: described by a person first.",
        },
        "notes": [
            "Measures the damage reading only. Cost accuracy against real repair invoices needs the insurer's data.",
            "The dollar gap compares the AI's estimate with the estimate priced from the human labels, using the same sample price table.",
            "Each model ran twice per claim; the two runs are merged the same way the app does it.",
            "The prompt was written on 12 other photos. None of the scored photos were used to tune it.",
            "Small sample: one claim is about 4 points. Treat differences of a few points as noise.",
        ],
        "results": results,
        "single_run": single,
    }
    EVAL.mkdir(parents=True, exist_ok=True)
    (EVAL / "summary.json").write_text(json.dumps(summary, indent=1))
    return summary


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "score"])
    ap.add_argument("--models", nargs="*", default=["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])
    ap.add_argument("--conditions", nargs="*", default=CONDITIONS)
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--concurrency", type=int, default=6)
    args = ap.parse_args()
    if args.cmd == "run":
        asyncio.run(run(args.models, args.conditions, args.runs, args.concurrency))
    s = score()
    for r in s["results"]:
        print(f"{r['model_name']:26s} {r['condition']:17s} recall {r['recall']:5} precision {r['precision']:5} type {r['damage_type_accuracy']:5} "
              f"sev {r['severity_accuracy']:5} side {r['side_accuracy']:5} route {r['route_agreement']:5} gap ${r['mean_abs_gap_usd']:6} "
              f"within20 {r['claims_within_20pct']:5} cost ${r['cost_per_claim_usd']} lat {r['median_latency_s']}s")
