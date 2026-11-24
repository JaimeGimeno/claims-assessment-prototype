"""Ties the steps together: photos -> AI assessment -> pricing -> routing -> review."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import List, Optional

from . import assess, db, evaluation, imaging, refdata, routing
from .config import DAILY_LIVE_RUNS, DATA_DIR, PHOTO_DIR, UPLOAD_DIR
from .pricing import build_estimate

PRECOMPUTED = DATA_DIR / "precomputed"


class CapReached(Exception):
    pass


def photo_path(photo_id: str) -> Optional[Path]:
    p = refdata.photos().get(photo_id)
    if p:
        return PHOTO_DIR / p["file"]
    if photo_id.startswith("up-") and photo_id.replace("-", "").isalnum():
        f = UPLOAD_DIR / f"{photo_id}.jpg"
        return f if f.exists() else None
    return None


def seed() -> None:
    """Loads the sample claims and their stored assessments on first start."""
    db.init()
    for claim in json.loads((DATA_DIR / "claims.json").read_text()):
        if db.get_claim(claim["id"]) is None:
            db.put_claim(claim)
        if db.get_assessment(claim["id"]) is None:
            f = PRECOMPUTED / f"{claim['id']}.json"
            if f.exists():
                a = json.loads(f.read_text())
                db.put_assessment(claim["id"], a, live=False)
                db.put_review(claim["id"], _initial_findings(a))


def _initial_findings(assessment: dict) -> list:
    return [dict(f) for f in assessment.get("findings", [])]


def load_photos(photo_ids: List[str]):
    jpegs, gates = [], []
    for pid in photo_ids:
        path = photo_path(pid)
        if path is None:
            raise FileNotFoundError(pid)
        img = imaging.load_image(path.read_bytes())
        gates.append(imaging.quality_gate(img))
        jpegs.append(imaging.to_jpeg(img))
    return jpegs, gates


async def run_assessment(claim: dict, model: str, live: bool = True, enforce_cap: bool = True,
                         with_description: bool = True, n_runs: int = 2) -> dict:
    """Runs the AI step for a claim and stores the result. A model failure is stored
    as a failed assessment; routing then sends the claim to full review."""
    if enforce_cap and db.live_runs_today() >= DAILY_LIVE_RUNS:
        raise CapReached()
    jpegs, gates = load_photos(claim["photos"])
    a = await assess.assess_claim(model, claim, jpegs, claim["photos"], gates, with_description=with_description, n_runs=n_runs)
    if live:
        db.log_model_call(claim["id"], model, a.get("tokens_in", 0), a.get("tokens_out", 0), a.get("cost_usd", 0.0), a["status"] == "ok")
    a.pop("raw_runs", None)
    db.put_assessment(claim["id"], a, live=live)
    db.put_review(claim["id"], _initial_findings(a))
    return a


def reference_for(claim: dict):
    """Reference labels for a claim made only of sample photos that have labels."""
    labs, tiers = [], set()
    for pid in claim["photos"]:
        lab, tier = refdata.labels_for(pid)
        if lab is None:
            return None, None
        labs.append(lab)
        tiers.add(tier)
    return evaluation.claim_reference(labs), ("human" if tiers == {"human"} else "ai")


def claim_view(claim_id: str, full: bool = True) -> Optional[dict]:
    claim = db.get_claim(claim_id)
    if claim is None:
        return None
    settings = db.get_settings()
    a = db.get_assessment(claim_id)
    review = db.get_review(claim_id) or {"findings": [], "status": "pending", "shop_id": None, "note": None, "decided_at": None}
    findings = review["findings"]
    for f in findings:
        f["part_name"] = refdata.parts()[f["part"]]["name"]
    cls = claim["vehicle"].get("vehicle_class") or "midsize_standard"
    estimate = build_estimate(findings, cls)
    if a is None:
        route = {"route": None, "reasons": [{"code": "not_assessed", "text": "This claim hasn't been assessed yet."}], "flags": {}, "info_requests": []}
    else:
        route = routing.route_claim(claim, a, findings, estimate, settings)
    edited = any(f.get("edited") or f.get("source") == "adjuster" for f in findings) or (a is not None and len(findings) != len(a.get("findings", [])))
    summary = {
        "id": claim["id"], "policy_number": claim.get("policy_number", ""), "policyholder": claim.get("policyholder", ""),
        "vehicle": claim["vehicle"], "photos": claim["photos"], "sample": bool(claim.get("sample")), "source": claim.get("source", "sample"),
        "created_at": claim.get("created_at"),
        "route": route["route"], "route_name": routing.ROUTE_NAMES.get(route["route"], "Not assessed"),
        "route_reasons": route["reasons"], "flags": route.get("flags", {}),
        "estimate_total": estimate["totals"]["total"], "estimate_low": estimate["totals"]["low"], "estimate_high": estimate["totals"]["high"],
        "estimate_is_range": estimate["totals"]["is_range"], "n_findings": len(findings), "status": review["status"],
        "owner": owner_of(review["status"], route["route"]),
        "assessed": a is not None, "assessment_failed": bool(a and a.get("status") != "ok"),
        "model": (a or {}).get("model"), "live": (a or {}).get("live"), "edited": edited,
    }
    if not full:
        return summary
    ref, tier = reference_for(claim)
    reference = None
    if ref is not None and a is not None and a.get("status") == "ok":
        cmp = evaluation.compare(a.get("findings", []), ref)
        reference = {
            "tier": tier, "findings": evaluation.label_view(ref), "structural_suspected": ref["structural_suspected"],
            "ambiguous": ref["ambiguous"], "compare": cmp["counts"],
            "rows": [{"status": r["status"], "optional": r.get("optional", False),
                      "ref": r["ref"] and dict(r["ref"], part_name=refdata.parts()[r["ref"]["part"]]["name"]),
                      "ai": r["ai"] and {k: r["ai"].get(k) for k in ("id", "part", "part_name", "side", "damage_type", "severity", "confidence")},
                      "severity_ok": r.get("severity_ok"), "type_ok": r.get("type_ok"), "side_ok": r.get("side_ok")} for r in cmp["rows"]],
            "reference_total": evaluation.reference_total(cmp, cls),
            "ai_total": build_estimate(a.get("findings", []), cls)["totals"]["total"],
        }
    photo_meta = {p["photo_id"]: p for p in (a or {}).get("photos", [])}
    photos = [{"id": pid, "url": f"/photos/{pid}", "usable": photo_meta.get(pid, {}).get("usable", True),
               "issue_text": photo_meta.get(pid, {}).get("issue_text", ""), "view": photo_meta.get(pid, {}).get("view", ""),
               "runs_disagree": photo_meta.get(pid, {}).get("runs_disagree", False)} for pid in claim["photos"]]
    return {
        **summary,
        "claim": claim,
        "photo_list": photos,
        "assessment": a and {k: a.get(k) for k in ("status", "error", "model", "cost_usd", "latency_s", "n_runs", "assessed_at", "live",
                                                    "vehicle_check", "description_check", "structural_suspected", "structural_reason",
                                                    "structural_runs", "info_requests", "suggested_vehicle_class", "tokens_in", "tokens_out")},
        "ai_findings": (a or {}).get("findings", []),
        "findings": findings,
        "estimate": estimate,
        "routing": route,
        "review": {k: review[k] for k in ("status", "shop_id", "note", "decided_at")},
        "corrections": db.corrections(claim_id),
        "reference": reference,
        "settings": settings,
    }


FIELD_NAMES = {"part": "Part", "side": "Side", "damage_type": "Damage type", "severity": "Severity",
               "operation_override": "Operation", "price_override": "Line price"}


def finding_label(f: dict) -> str:
    side = f.get("side") if f.get("side") in ("left", "right") else ""
    return (refdata.parts()[f["part"]]["name"] + (f", {side}" if side else "")).strip()


def edit_finding(claim_id: str, finding_id: str, changes: dict, reason_code: str, note: str, actor: str = "") -> None:
    review = db.get_review(claim_id)
    f = next(x for x in review["findings"] if x["id"] == finding_id)
    logged = []
    for k, v in changes.items():
        if k in FIELD_NAMES and f.get(k) != v:
            logged.append({"field": FIELD_NAMES[k], "from": f.get(k), "to": v})
            if v is None:
                f.pop(k, None)
            else:
                f[k] = v
    if not logged:
        return
    if any(c["field"] in ("Part", "Damage type", "Severity") for c in logged):
        f.pop("severity_alt", None)  # the reviewer has decided, so no range from the two runs
        f["action"] = "" if f.get("action") == "unclear" else f.get("action", "")
    f["edited"] = True
    f["confidence"] = "high"  # a person has checked it
    db.put_review(claim_id, review["findings"], review["status"], review["shop_id"], review["note"], review["decided_at"])
    db.log_correction(claim_id, "edit", finding_label(f), logged, reason_code, note, actor)


def add_finding(claim_id: str, data: dict, reason_code: str, note: str, actor: str = "") -> None:
    review = db.get_review(claim_id) or {"findings": [], "status": "pending", "shop_id": None, "note": None, "decided_at": None}
    n = 1 + max([int(x["id"][1:]) for x in review["findings"] if x["id"][1:].isdigit()] + [0])
    f = {"id": f"f{n}", "part": data["part"], "side": data.get("side", "unknown"), "damage_type": data["damage_type"],
         "severity": data["severity"], "action": "", "paint_damaged": True, "confidence": "high", "source": "adjuster",
         "photo_id": data.get("photo_id") or "", "reason": "Added by the adjuster.", "agreement": "adjuster"}
    review["findings"].append(f)
    db.put_review(claim_id, review["findings"], review["status"], review["shop_id"], review["note"], review["decided_at"])
    db.log_correction(claim_id, "add", finding_label(f),
                      [{"field": "Damage", "from": None, "to": f"{data['damage_type']}, {data['severity']}"}], reason_code, note, actor)


def remove_finding(claim_id: str, finding_id: str, reason_code: str, note: str, actor: str = "") -> None:
    review = db.get_review(claim_id)
    f = next(x for x in review["findings"] if x["id"] == finding_id)
    review["findings"] = [x for x in review["findings"] if x["id"] != finding_id]
    db.put_review(claim_id, review["findings"], review["status"], review["shop_id"], review["note"], review["decided_at"])
    db.log_correction(claim_id, "remove", finding_label(f),
                      [{"field": "Damage", "from": f"{f['damage_type']}, {f['severity']}", "to": None}], reason_code, note, actor)


# What each action does to the claim's status. A full-review claim is checked by a claims agent
# ("agent_checked") before the senior adjuster approves it; a fast-track claim skips that step.
STATUS_AFTER = {"approve": "approved", "reject": "rejected", "request_info": "info_requested", "reopen": "pending",
                "send_for_approval": "agent_checked", "send_back": "pending"}


def owner_of(status: str, route: Optional[str]) -> Optional[str]:
    """Whose turn it is: the claims agent, the senior adjuster, the policyholder, or nobody (decided)."""
    if status in ("approved", "rejected"):
        return None
    if status == "info_requested":
        return "policyholder"
    if status == "agent_checked" or route == "fast_track":
        return "senior"
    return "agent"


def decide(claim_id: str, action: str, shop_id: Optional[str], note: str, actor: str = "") -> None:
    review = db.get_review(claim_id) or {"findings": [], "status": "pending", "shop_id": None, "note": None, "decided_at": None}
    status = STATUS_AFTER[action]
    shop_name = next((s["name"] for s in refdata.reference()["shops"] if s["id"] == shop_id), None)
    db.put_review(claim_id, review["findings"], status, shop_id if action == "approve" else None, note,
                  time.time() if status != "pending" else None)
    db.log_correction(claim_id, action, "", [{"field": "Authorised shop", "from": None, "to": shop_name}] if shop_name and action == "approve" else [],
                      "", note, actor)


# ------------------------------------------------------------------ try-outs: a sample policy drafted by the AI

# Sample new-car prices by class. A car's sample value falls 13% a year from there.
SAMPLE_NEW_PRICE = {"small_standard": 22000, "small_luxury": 36000, "midsize_standard": 30000, "midsize_luxury": 48000,
                    "suv_standard": 36000, "suv_luxury": 60000, "pickup_standard": 45000, "pickup_luxury": 68000}


def sample_value(vehicle_class: str, year: Optional[int]) -> int:
    base = SAMPLE_NEW_PRICE.get(vehicle_class, 30000)
    this_year = time.gmtime().tm_year
    age = max(0, this_year - year) if year and 1980 <= year <= this_year + 1 else 6
    return int(round(max(base * 0.08, base * 0.87 ** age) / 100) * 100)


def drafted_vehicle(v: dict) -> dict:
    """Turns the AI's identification into the car on a sample policy."""
    cls = v.get("vehicle_class") if v.get("vehicle_class") in SAMPLE_NEW_PRICE else "midsize_standard"
    year = v.get("year") if v.get("identified") and v.get("year") else None
    return {"make": (v.get("make") or "").strip()[:40] if v.get("identified") else "",
            "model": (v.get("model") or "").strip()[:40] if v.get("identified") else "",
            "year": year, "color": (v.get("color") or "").strip()[:30], "vehicle_class": cls,
            "value": sample_value(cls, year), "assumed": True, "identified": bool(v.get("identified"))}


def stored_vehicle(photo_id: str) -> Optional[dict]:
    f = PRECOMPUTED / f"vehicle-{photo_id}.json"
    return json.loads(f.read_text()) if f.exists() else None
