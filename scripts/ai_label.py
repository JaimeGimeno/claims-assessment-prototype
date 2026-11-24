"""AI labelling for the photos no person has checked, and how far to trust it.

  python scripts/ai_label.py label       # four models from three providers label each photo, with extra input
  python scripts/ai_label.py consensus   # build data/labels_ai.json and measure agreement with the human labels
  python scripts/ai_label.py run         # run the app's models on every sample photo (cached)
  python scripts/ai_label.py score       # score those runs against both label tiers

The labellers get more than the app does: the dataset's hand-drawn damage outline and
its part labels, and (for Claude) more thinking effort. A label is kept when at least
two of the models report the part; a part only one model reports is marked optional.
These labels are AI-generated and are always reported separately from the human-checked ones.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import statistics
import sys
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import assess, evaluation, imaging, refdata, service  # noqa: E402
from backend.config import DATA_DIR, MODELS, PHOTO_DIR  # noqa: E402
from backend.pricing import build_estimate  # noqa: E402
from backend.providers import ModelError, call_model  # noqa: E402
from backend.refdata import SEVERITY_ORDER  # noqa: E402
from run_eval import BUDGET_USD, EVAL, RAW, add_spend, pct, spend_total  # noqa: E402

LABELLERS = [("claude-opus-5-5", "high"), ("gemini-3.1-pro-preview", "medium"), ("gemini-3.5-flash", "medium"), ("gpt-5", "medium")]
LAB_RAW = EVAL / "raw" / "_labelling"
PHOTO_CLASS = "midsize_standard"  # single photos have no policy behind them


def outlines() -> dict:
    return json.loads((DATA_DIR / "dataset_outlines.json").read_text())


def overlay_jpeg(pid: str) -> bytes:
    img = Image.open(PHOTO_DIR / refdata.photos()[pid]["file"]).convert("RGB")
    d = ImageDraw.Draw(img)
    for poly in outlines()[pid]["damage"]:
        pts = list(zip(poly[0::2], poly[1::2]))
        if len(pts) >= 3:
            d.line(pts + [pts[0]], fill=(255, 221, 0), width=5)
    return imaging.to_jpeg(img)


def labelling_photos() -> list:
    """Kaggle photos that have dataset outlines: the 20 human-checked ones (to measure
    agreement) and the AI tier (to label)."""
    o = outlines()
    return [p["id"] for p in refdata.photos().values() if p["source"] == "kaggle" and p["tier"] in ("human", "ai") and p["id"] in o]


async def label(concurrency: int = 5) -> None:
    sem = asyncio.Semaphore(concurrency)
    o = outlines()

    async def one(model, effort, pid):
        f = LAB_RAW / model / f"{pid}.json"
        if f.exists():
            return
        async with sem:
            if spend_total() >= BUDGET_USD:
                return
            jpegs, _ = service.load_photos([pid])
            hint = sorted({x["part"].replace("_", " ") for x in o[pid]["parts"]})
            parts = [
                {"text": "Car on the policy: not given.\nAccident description from the claim: not provided.\n\nThere is one photo."},
                {"text": "Photo 1:"}, {"jpeg": jpegs[0]},
                {"text": "The same photo again, with the damaged area outlined in yellow by the people who built the dataset. "
                         "Use the outline to find the damage. It does not tell you the part, the damage type or the severity, and it may not cover every damaged part."},
                {"jpeg": overlay_jpeg(pid)},
                {"text": "The dataset marks these parts as visible in the photo, damaged or not (its list only has five parts): " + (", ".join(hint) or "none") +
                         ".\n\nAssess the damage. Treat both images as photo 1."},
            ]
            try:
                r = await call_model(model, assess.build_system_prompt(), parts, assess.build_schema(), effort)
            except ModelError as e:
                print("FAILED", model, pid, e)
                return
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(r))
            add_spend(model, r["cost_usd"], "ai_labelling")

    ids = labelling_photos()
    for model, effort in LABELLERS:
        await asyncio.gather(*[one(model, effort, pid) for pid in ids])
        print(model, "labelled; spend $", spend_total())


def consensus_for(pid: str):
    """Returns (label, votes) or (None, n) when fewer than two labellers answered."""
    runs = []
    for model, _ in LABELLERS:
        f = LAB_RAW / model / f"{pid}.json"
        if f.exists():
            runs.append(assess._clean_run(json.loads(f.read_text())["data"], 1))
    if len(runs) < 2:
        return None, len(runs)
    need = 2
    groups = {}  # part -> list of findings (one per model at most)
    for r in runs:
        seen = set()
        for f in r["findings"]:
            if f["part"] in seen:
                continue
            seen.add(f["part"])
            groups.setdefault(f["part"], []).append(f)
    findings = []
    for part, fs in groups.items():
        sevs = sorted((f["severity"] for f in fs), key=SEVERITY_ORDER.index)
        sev = Counter(sevs).most_common(1)[0][0] if Counter(sevs).most_common(1)[0][1] >= 2 else sevs[len(sevs) // 2]
        types = Counter(f["damage_type"] for f in fs)
        dtype = types.most_common(1)[0][0]
        sides = Counter(f["side"] for f in fs if f["side"] in ("left", "right"))
        out = {"part": part, "side": sides.most_common(1)[0][0] if sides else "", "damage_type": dtype, "severity": sev, "votes": len(fs)}
        alt_s = sorted(set(sevs) - {sev}, key=SEVERITY_ORDER.index)
        if alt_s:
            out["also_ok_severity"] = alt_s
        alt_t = sorted(set(types) - {dtype})
        if alt_t:
            out["also_ok_damage_type"] = alt_t
        if len(fs) < need:
            out["optional"] = True  # only one model saw it
        findings.append(out)
    s_votes = sum(1 for r in runs if r.get("structural_suspected"))
    label = {
        "findings": findings,
        "structural_suspected": s_votes * 2 > len(runs),
        "structural_uncertain": 0 < s_votes < len(runs),
        "ambiguous": any(f.get("optional") or f.get("also_ok_severity") for f in findings),
        "labelled_by": "AI consensus (" + ", ".join(MODELS[m]["name"] for m, _ in LABELLERS) + "), not checked by a person",
        "labellers": len(runs),
    }
    return label, len(runs)


def consensus() -> dict:
    human = refdata.human_labels()
    ai_labels, tot, n = {}, Counter(), 0
    unanimous_part = part_groups = unanimous_sev = sev_groups = 0
    for pid in labelling_photos():
        lab, k = consensus_for(pid)
        if lab is None:
            continue
        for f in lab["findings"]:
            part_groups += 1
            unanimous_part += f["votes"] == k
            if f["votes"] >= 2:
                sev_groups += 1
                unanimous_sev += not f.get("also_ok_severity")
        if pid in human:
            # how well does the AI consensus reproduce the human-checked label?
            required = [dict(f, id=f"c{i}", confidence="high") for i, f in enumerate(lab["findings"]) if not f.get("optional")]
            cmp = evaluation.compare(required, evaluation.claim_reference([human[pid]]))
            tot.update(cmp["counts"])
            n += 1
        else:
            ai_labels[pid] = lab
    (DATA_DIR / "labels_ai.json").write_text(json.dumps(ai_labels, indent=1))
    agreement = {
        "photos": n,
        "human_findings_also_in_ai_labels": pct(tot["found"], tot["required"]),
        "ai_label_findings_confirmed_by_human_labels": pct(tot["ai_total"] - tot["extra"], tot["ai_total"]),
        "damage_type_agreement": pct(tot["type_ok"], tot["matched"]),
        "severity_agreement": pct(tot["severity_ok"], tot["matched"]),
        "side_agreement": pct(tot["side_ok"], tot["matched"]),
    }
    out = {
        "photos_labelled": len(ai_labels),
        "photos_with_a_disputed_finding": sum(1 for l in ai_labels.values() if l["ambiguous"]),
        "findings_all_labellers_reported": pct(unanimous_part, part_groups),
        "findings_with_unanimous_severity": pct(unanimous_sev, sev_groups),
        "agreement_with_human": agreement,
    }
    (EVAL / "ai_labelling.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
    return out


async def run(models: list, concurrency: int = 6) -> None:
    """Every sample photo as a one-photo claim, no car and no description, two runs."""
    sem = asyncio.Semaphore(concurrency)

    async def one(model, pid, k):
        f = RAW / model / "photo" / f"{pid}_run{k}.json"
        if f.exists():
            return
        async with sem:
            if spend_total() >= BUDGET_USD:
                return
            jpegs, _ = service.load_photos([pid])
            try:
                r = await assess.run_once(model, {"vehicle": {}}, jpegs, with_description=False)
            except ModelError as e:
                print("FAILED", model, pid, e)
                return
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(r))
            add_spend(model, r["cost_usd"], "sample_photo_runs")

    for m in models:
        await asyncio.gather(*[one(m, pid, k) for pid in refdata.photos() for k in (1, 2)])
        print(m, "done; spend $", spend_total())


def photo_runs(model: str, pid: str) -> list:
    out = []
    for k in (1, 2):
        f = RAW / model / "photo" / f"{pid}_run{k}.json"
        if f.exists():
            out.append(json.loads(f.read_text()))
    return out


def score_tier(model: str, labels: dict) -> dict:
    tot, gaps, gap_pct, within, n = Counter(), [], [], 0, 0
    struct = Counter()
    for pid, lab in labels.items():
        runs = photo_runs(model, pid)
        if len(runs) < 2:
            continue
        n += 1
        _, gates = service.load_photos([pid])
        a = assess.merge_runs([r["data"] for r in runs], [pid], gates)
        ref = evaluation.claim_reference([lab])
        cmp = evaluation.compare(a["findings"], ref)
        tot.update(cmp["counts"])
        ai_total = build_estimate(a["findings"], PHOTO_CLASS)["totals"]["total"]
        ref_total = evaluation.reference_total(cmp, PHOTO_CLASS)
        gaps.append(abs(ai_total - ref_total))
        if ref_total > 0:
            gap_pct.append(abs(ai_total - ref_total) / ref_total * 100)
            within += abs(ai_total - ref_total) / ref_total <= 0.2
        else:
            gap_pct.append(0.0 if ai_total == 0 else 100.0)
            within += ai_total == 0
        if not ref["structural_uncertain"]:
            s_ai, s_ref = a["structural_suspected"], ref["structural_suspected"]
            struct["tp" if s_ai and s_ref else "fp" if s_ai else "fn" if s_ref else "tn"] += 1
    if not n:
        return {}
    return {
        "model": model, "model_name": MODELS[model]["name"], "photos": n,
        "recall": pct(tot["found"], tot["required"]), "precision": pct(tot["ai_total"] - tot["extra"], tot["ai_total"]),
        "damage_type_accuracy": pct(tot["type_ok"], tot["matched"]), "severity_accuracy": pct(tot["severity_ok"], tot["matched"]),
        "side_accuracy": pct(tot["side_ok"], tot["matched"]),
        "mean_abs_gap_usd": round(statistics.mean(gaps)), "median_abs_gap_pct": round(statistics.median(gap_pct), 1),
        "claims_within_20pct": pct(within, n), "structural": dict(struct),
    }


def score(models: list) -> None:
    human = {k: v for k, v in refdata.human_labels().items() if k.startswith("k-")}
    ai = refdata.ai_labels()
    summary = json.loads((EVAL / "summary.json").read_text())
    stats = json.loads((EVAL / "ai_labelling.json").read_text()) if (EVAL / "ai_labelling.json").exists() else {}
    rows_ai = [r for r in (score_tier(m, ai) for m in models) if r]
    rows_h = [r for r in (score_tier(m, human) for m in models) if r]
    summary["ai_labelling"] = {
        "available": bool(rows_ai),
        "method": "Four models from three providers (" + ", ".join(MODELS[m]["name"] for m, _ in LABELLERS) + ") each labelled every photo. "
                  "They were given more than the app gets: the dataset's hand-drawn damage outline and its part labels. A finding is kept when at "
                  "least two of them report the part; a part only one reports is optional. No person checked these labels, so they are "
                  "reported apart from the human-checked results. The models scored on these labels are Claude models, and one of the labellers is also Claude, which favours them somewhat.",
        "stats": {k: v for k, v in stats.items() if k != "agreement_with_human"},
        "agreement_with_human": stats.get("agreement_with_human", {}),
        "results": rows_ai,
        "same_photos_human_labels": rows_h,
        "note": "Each photo is scored as a one-photo claim with no car and no accident description.",
    }
    (EVAL / "summary.json").write_text(json.dumps(summary, indent=1))
    for name, rows in (("AI-labelled tier", rows_ai), ("Human-checked, same single-photo setup", rows_h)):
        print(name)
        for r in rows:
            print(f"  {r['model_name']:22s} n={r['photos']:3d} recall {r['recall']} precision {r['precision']} type {r['damage_type_accuracy']} sev {r['severity_accuracy']} within20 {r['claims_within_20pct']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["label", "consensus", "run", "score"])
    ap.add_argument("--models", nargs="*", default=["claude-haiku-5-5", "claude-sonnet-5-5"])
    ap.add_argument("--concurrency", type=int, default=5)
    args = ap.parse_args()
    if args.cmd == "label":
        asyncio.run(label(args.concurrency))
    elif args.cmd == "consensus":
        consensus()
    elif args.cmd == "run":
        asyncio.run(run(args.models))
    else:
        score(args.models)
