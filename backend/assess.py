"""The AI step: read the photos and say what is damaged and how badly. Nothing else.

It never sees a price and never decides a route. Its answer must fit a fixed
format built from our own lists, and it runs twice so we can compare the two runs.
"""
from __future__ import annotations

import asyncio
from typing import List, Optional

from .providers import ModelError, call_model
from .refdata import CONFIDENCE_ORDER, SEVERITY_ORDER, SIDES, damage_types, parts, reference

PHOTO_ISSUES = ["none", "blurry", "too_dark", "too_far", "damage_not_visible", "not_a_vehicle", "obstructed", "other"]
ISSUE_TEXT = {
    "blurry": "blurred", "too_dark": "too dark", "too_far": "taken from too far", "damage_not_visible": "damage not visible",
    "not_a_vehicle": "not a vehicle", "obstructed": "view blocked", "other": "unusable", "too_small": "too small", "overexposed": "overexposed",
}

PART_GLOSSARY = {
    "front_bumper": "the bumper cover at the front, below the headlamps",
    "grille": "the grille between the headlamps",
    "hood": "the panel over the engine bay",
    "headlamp": "a front light unit",
    "fender": "the front wing: the panel over a front wheel, between the front bumper and the front door",
    "windshield": "the front glass",
    "front_door": "a front door",
    "rear_door": "a rear door",
    "mirror": "a door mirror",
    "side_window": "glass in a door or a fixed side window",
    "rocker_panel": "the sill: the strip of body under the doors, between the front and rear wheels",
    "quarter_panel": "the rear wing: the fixed body panel over a rear wheel, between the rear door and the rear bumper",
    "roof": "the roof panel and the rails above the doors",
    "trunk_lid": "the trunk lid, tailgate or liftgate",
    "rear_bumper": "the bumper cover at the rear",
    "tail_lamp": "a rear light unit",
    "back_glass": "the rear glass",
    "wheel": "a wheel or tyre",
}


def build_schema() -> dict:
    """The fixed output format. Enums come from the reference data."""
    def obj(props: dict) -> dict:
        return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}

    def enum(values) -> dict:
        return {"type": "string", "enum": list(values)}

    return obj({
        "photos": {"type": "array", "items": obj({
            "photo": {"type": "integer"},
            "view": {"type": "string"},
            "usable": {"type": "boolean"},
            "issue": enum(PHOTO_ISSUES),
        })},
        "vehicle_seen": {"type": "string"},
        "vehicle_matches_policy": enum(["yes", "no", "cannot_tell"]),
        "vehicle_mismatch_reason": {"type": "string"},
        "description_consistent": enum(["yes", "no", "cannot_tell", "not_provided"]),
        "description_mismatch_reason": {"type": "string"},
        "findings": {"type": "array", "items": obj({
            "part": enum(parts().keys()),
            "side": enum(SIDES),
            "damage_type": enum(damage_types().keys()),
            "severity": enum(SEVERITY_ORDER),
            "action": enum(["repair", "replace", "unclear"]),
            "paint_damaged": {"type": "boolean"},
            "confidence": enum(CONFIDENCE_ORDER),
            "photo": {"type": "integer"},
            "reason": {"type": "string"},
        })},
        "structural_suspected": {"type": "boolean"},
        "structural_reason": {"type": "string"},
        "info_requests": {"type": "array", "items": {"type": "string"}},
        "suggested_vehicle_class": enum([c["id"] for c in reference()["vehicle_classes"]]),
    })


def build_system_prompt() -> str:
    part_lines = "\n".join(f"- {pid}: {PART_GLOSSARY[pid]}" for pid in parts())
    sev_lines = "\n".join(f"- {s['id']}: {s['meaning']}" for s in reference()["severities"])
    return f"""You assess photos of a damaged car for a motor insurance claim. A claims adjuster reviews everything you report, edits it where you are wrong, and makes the decision. Your job is only to describe what the photos show: which parts are damaged, how, and how badly. Prices and the handling of the claim are decided elsewhere, so don't estimate costs.

What matters most is that the adjuster can trust your list. A finding that isn't there costs them time and trust; a missed finding costs the insurer money or hides a safety problem. Report what you can see and say plainly when you can't tell.

How to read the photos
- Go through each photo and check every part of the car that is visible in it, including the low areas near the ground and the edges of the frame, not only the most obvious damage.
- Report exactly one finding per damaged part and side, combining everything you see on that part. If one impact crosses several parts, report each part.
- A finding means "I believe this part is damaged". Don't add a finding for a part that looks intact, or to note that you checked it, or because damage there would be plausible given the impact.
- Only report damage you can see. Reflections, dirt, water marks, insects, shadows and the normal gaps between panels are not damage. If a mark is probably damage but the photo leaves real doubt, report it with low confidence; if it is more likely not damage, leave it out.
- The accident description, when there is one, is a hint about where to look. It is not evidence. Report what the photos show, and say so if the two don't match.
- Sides are the car's own left and right, as seen from the driver's seat facing forward. Use "center" for parts with no side that are hit in the middle, and "unknown" if you can't tell.

Parts (use these ids)
{part_lines}

Damage types: scratch (paint or surface marks), dent (the panel is pushed in or deformed), crack (the material is split or torn), shattered_glass, broken_lamp, missing_part (a part is gone or has come loose from its mounting), flat_tyre. Pick the one that drives the repair: a dent that also has scratches is a dent.

Severity
{sev_lines}
A sharp crease or fold in a metal panel usually means severe, because creased metal is hard to restore.

For each finding also give
- action: "repair" or "replace" when the photo makes it clear, otherwise "unclear".
- paint_damaged: whether the paint is broken or scraped on that part.
- confidence: high when the damage and the part are unmistakable; medium when you are fairly sure; low when the photo leaves real doubt.
- photo: the number of the photo that shows it best.
- reason: one short sentence on what you see, written for the adjuster.

Photo checks
- For each photo say whether it is usable for assessing damage. A photo is not usable if it is too blurred, too dark, taken from too far to see the damage, blocked, or doesn't show a vehicle. A usable photo can show no damage at all.
- vehicle_seen: the car you see, in a few words. vehicle_matches_policy: compare it with the car on the policy (body type, colour, make if a badge shows). Answer "no" only for a clear mismatch, and "cannot_tell" for close-ups.
- structural_suspected: true if anything suggests damage beyond the outer panels, such as a heavy impact, crushed or buckled body structure, panels that no longer line up, or damage around the pillars, sills, roof rails or the area behind a bumper.
- info_requests: leave this empty in the normal case. Use it only when the photos are not enough to assess the main damage at all (unusable photos, the wrong car, or the damaged area isn't shown). More angles would always be nice to have; that alone is not a reason to ask. When you do ask, be specific, for example "a close photo of the rear left door from about one metre".
- suggested_vehicle_class: your best guess of the size and tier of the car."""


def build_user_parts(claim: dict, jpegs: List[bytes], with_description: bool = True) -> list:
    v = claim.get("vehicle", {})
    desc = (claim.get("accident_description") or "").strip() if with_description else ""
    car = " ".join(str(x) for x in [v.get("year"), v.get("color"), v.get("make"), v.get("model")] if x)
    head = f"Car on the policy: {car or 'not given'}.\nAccident description from the claim: {desc if desc else 'not provided'}.\n\nThe photos follow, numbered from 1."
    out = [{"text": head}]
    for i, j in enumerate(jpegs, start=1):
        out.append({"text": f"Photo {i}:"})
        out.append({"jpeg": j})
    out.append({"text": "Assess the damage."})
    return out


async def run_once(model: str, claim: dict, jpegs: List[bytes], with_description: bool = True, effort: str = "medium") -> dict:
    return await call_model(model, build_system_prompt(), build_user_parts(claim, jpegs, with_description), build_schema(), effort)


def _clean_run(data: dict, n_photos: int) -> dict:
    """Keeps only what fits our lists, in case a provider ignores part of the format."""
    findings = []
    for f in data.get("findings") or []:
        if f.get("part") in parts() and f.get("damage_type") in damage_types() and f.get("severity") in SEVERITY_ORDER:
            f = dict(f)
            f["side"] = f.get("side") if f.get("side") in SIDES else "unknown"
            f["confidence"] = f.get("confidence") if f.get("confidence") in CONFIDENCE_ORDER else "medium"
            f["action"] = f.get("action") if f.get("action") in ("repair", "replace", "unclear") else "unclear"
            f["photo"] = f.get("photo") if isinstance(f.get("photo"), int) and 1 <= f["photo"] <= n_photos else 1
            f["paint_damaged"] = bool(f.get("paint_damaged", True))
            findings.append(f)
    # one finding per part and side: keep the most severe if a run repeats itself
    best = {}
    for f in findings:
        k = (f["part"], f["side"])
        if k not in best or SEVERITY_ORDER.index(f["severity"]) > SEVERITY_ORDER.index(best[k]["severity"]):
            best[k] = f
    data = dict(data)
    data["findings"] = list(best.values())
    return data


def _key(f: dict):
    return (f["part"], f["side"])


def _match(a: List[dict], b: List[dict]):
    """Pairs findings from two runs: same part and side first, then same part with an unknown side."""
    pairs, used = [], set()
    for fa in a:
        hit = None
        for j, fb in enumerate(b):
            if j not in used and _key(fa) == _key(fb):
                hit = j
                break
        if hit is None:
            for j, fb in enumerate(b):
                if j not in used and fa["part"] == fb["part"] and ("unknown" in (fa["side"], fb["side"]) or "center" in (fa["side"], fb["side"])):
                    hit = j
                    break
        if hit is not None:
            used.add(hit)
        pairs.append((fa, b[hit] if hit is not None else None))
    rest = [fb for j, fb in enumerate(b) if j not in used]
    return pairs, rest


def merge_runs(runs: List[dict], photo_ids: List[str], gates: List[dict]) -> dict:
    """Combines the runs into one assessment and turns their agreement into a confidence.

    Two runs agreeing shows the case isn't ambiguous for the model. It doesn't prove
    the answer is right; the eval is what catches mistakes the model makes every time.
    """
    n = len(photo_ids)
    runs = [_clean_run(r, n) for r in runs]
    a = runs[0]
    b = runs[1] if len(runs) > 1 else None

    findings = []

    def add(f, agreement, other=None):
        conf = f["confidence"]
        out = {
            "part": f["part"], "part_name": parts()[f["part"]]["name"], "side": f["side"],
            "damage_type": f["damage_type"], "severity": f["severity"], "action": f["action"],
            "paint_damaged": f["paint_damaged"], "stated_confidence": f["confidence"],
            "photo_id": photo_ids[f["photo"] - 1], "reason": f.get("reason", ""), "agreement": agreement, "source": "ai",
        }
        if agreement == "one_run":
            conf = "low"
        elif other is not None:
            conf = CONFIDENCE_ORDER[min(CONFIDENCE_ORDER.index(f["confidence"]), CONFIDENCE_ORDER.index(other["confidence"]))]
            if other["severity"] != f["severity"]:
                # keep the more severe reading as the main one, and price the other as the low end
                sev = sorted([f["severity"], other["severity"]], key=SEVERITY_ORDER.index)
                out["severity"], out["severity_alt"] = sev[1], sev[0]
                out["agreement"] = "severity_differs"
                conf = CONFIDENCE_ORDER[max(0, CONFIDENCE_ORDER.index(conf) - 1)]
            if other["action"] != f["action"]:
                out["action"] = "unclear"
            if other["damage_type"] != f["damage_type"]:
                out["damage_type_alt"] = other["damage_type"]
            out["paint_damaged"] = f["paint_damaged"] or other["paint_damaged"]
        out["confidence"] = conf
        findings.append(out)

    if b is None:
        for f in a["findings"]:
            add(f, "single_run")
    else:
        pairs, rest = _match(a["findings"], b["findings"])
        for fa, fb in pairs:
            add(fa, "both_runs" if fb else "one_run", fb)
        for fb in rest:
            add(fb, "one_run")
        # Seen by one run only, and that run wasn't sure either: too weak to show.
        findings[:] = [f for f in findings if not (f["agreement"] == "one_run" and f["stated_confidence"] == "low")]
    for i, f in enumerate(findings, start=1):
        f["id"] = f"f{i}"

    photos = []
    for i, pid in enumerate(photo_ids):
        votes = []
        for r in runs:
            p = next((x for x in r.get("photos") or [] if x.get("photo") == i + 1), None)
            if p:
                votes.append(p)
        gate = gates[i] if i < len(gates) else {"ok": True}
        unusable_votes = [v for v in votes if not v.get("usable", True)]
        usable = gate.get("ok", True) and len(unusable_votes) < max(1, len(votes))  # unusable only if every run says so
        issue = gate.get("issue") or (unusable_votes[0].get("issue") if unusable_votes else "none")
        photos.append({
            "photo_id": pid, "usable": bool(usable), "issue": issue if not usable or unusable_votes else "none",
            "issue_text": ISSUE_TEXT.get(issue, "") if not usable else "",
            "runs_disagree": 0 < len(unusable_votes) < len(votes),
            "view": votes[0].get("view", "") if votes else "", "gate": gate,
        })
    # findings that point at a photo judged unusable are dropped: we don't assess from a bad photo
    bad = {p["photo_id"] for p in photos if not p["usable"]}
    findings = [f for f in findings if f["photo_id"] not in bad]

    def vote(field, yes="yes", no="no"):
        vals = [r.get(field) for r in runs]
        if all(v == no for v in vals):
            return "no"
        if any(v == no for v in vals):
            return "uncertain"
        return "yes" if any(v == yes for v in vals) else "cannot_tell"

    # the two runs usually ask for the same thing in different words: keep the first run's
    # requests and fall back to the second only if the first has none
    info = []
    for r in runs:
        info = [q.strip() for q in (r.get("info_requests") or []) if q.strip()]
        if info:
            break
    structural = [r for r in runs if r.get("structural_suspected")]
    desc = vote("description_consistent")
    if all(r.get("description_consistent") == "not_provided" for r in runs):
        desc = "not_provided"
    return {
        "status": "ok",
        "photos": photos,
        "vehicle_check": {"seen": a.get("vehicle_seen", ""), "match": vote("vehicle_matches_policy"),
                          "reason": next((r.get("vehicle_mismatch_reason", "") for r in runs if r.get("vehicle_matches_policy") == "no"), "")},
        "description_check": {"consistent": desc if desc != "uncertain" else "cannot_tell",
                              "reason": next((r.get("description_mismatch_reason", "") for r in runs if r.get("description_consistent") == "no"), "")},
        "findings": findings,
        # safety first: one run seeing structural signs is enough to flag it
        "structural_suspected": bool(structural),
        "structural_reason": structural[0].get("structural_reason", "") if structural else "",
        "structural_runs": f"{len(structural)} of {len(runs)}",
        "info_requests": info[:2],
        "suggested_vehicle_class": a.get("suggested_vehicle_class", ""),
        "n_runs": len(runs),
    }


async def assess_claim(model: str, claim: dict, jpegs: List[bytes], photo_ids: List[str], gates: List[dict],
                       with_description: bool = True, n_runs: int = 2, effort: str = "medium") -> dict:
    """Runs the model n_runs times in parallel and merges. Never raises: a failure
    comes back as status "failed", and routing sends the claim to full review."""
    usable_idx = [i for i, g in enumerate(gates) if g.get("ok", True)]
    if not usable_idx:
        out = merge_runs([{"findings": [], "photos": []}], photo_ids, gates)
        out.update({"model": model, "cost_usd": 0.0, "latency_s": 0.0, "tokens_in": 0, "tokens_out": 0, "raw_runs": []})
        return out
    results = await asyncio.gather(*[run_once(model, claim, jpegs, with_description, effort) for _ in range(n_runs)], return_exceptions=True)
    good = [r for r in results if isinstance(r, dict)]
    errors = [r for r in results if not isinstance(r, dict)]
    cost = sum(r["cost_usd"] for r in good)
    if not good:
        msg = str(errors[0]) if isinstance(errors[0], ModelError) else "Unexpected error while calling the model."
        return {"status": "failed", "error": msg, "model": model, "findings": [], "photos": [], "cost_usd": cost,
                "latency_s": 0.0, "tokens_in": 0, "tokens_out": 0, "raw_runs": []}
    out = merge_runs([r["data"] for r in good], photo_ids, gates)
    out.update({
        "model": model, "cost_usd": round(cost, 5), "latency_s": max(r["latency_s"] for r in good),
        "tokens_in": sum(r["tokens_in"] for r in good), "tokens_out": sum(r["tokens_out"] for r in good),
        "raw_runs": [r["data"] for r in good], "runs_failed": len(errors),
    })
    return out


# ------------------------------------------------------------------ try-outs only: draft the policy car

VEHICLE_SCHEMA = {
    "type": "object",
    "properties": {
        "make": {"type": "string"}, "model": {"type": "string"}, "year": {"type": "integer"}, "color": {"type": "string"},
        "vehicle_class": {"type": "string", "enum": [c["id"] for c in reference()["vehicle_classes"]]},
        "identified": {"type": "boolean"},
    },
    "required": ["make", "model", "year", "color", "vehicle_class", "identified"],
    "additionalProperties": False,
}

VEHICLE_PROMPT = """You identify the car in photos so that a sample insurance policy record can be filled in for a product demo. Give the make, the model, your best estimate of the model year, the colour, and the size and tier of the car. Use badges, lights and body shape. If the photos don't show enough to name the make or model (a close-up of one panel, for example), set identified to false, leave make and model empty, set year to 0, and still give your best guess of the colour and the class."""


async def identify_vehicle(model: str, jpegs: List[bytes]) -> dict:
    """A separate, small call used only by "Try it", where there is no policy. It is kept apart
    from the damage assessment so the assessment prompt, and the eval of it, stay unchanged."""
    parts_ = [{"text": "Photos of one car:"}] + [{"jpeg": j} for j in jpegs[:3]] + [{"text": "Identify the car."}]
    r = await call_model(model, VEHICLE_PROMPT, parts_, VEHICLE_SCHEMA, "low")
    d = r["data"]
    d["cost_usd"] = r["cost_usd"]
    return d
