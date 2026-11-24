"""Routing: fixed rules that send a claim to one of three routes, with reasons.

The insurer controls the thresholds. The AI never authorises anything.
"""
from __future__ import annotations

from .refdata import CONFIDENCE_ORDER

FAST_TRACK = "fast_track"
FULL_REVIEW = "full_review"
NEED_INFO = "need_more_information"

ROUTE_NAMES = {FAST_TRACK: "Fast-track", FULL_REVIEW: "Full review", NEED_INFO: "Need more information"}


def route_claim(claim: dict, assessment: dict, findings: list, estimate: dict, settings: dict) -> dict:
    """Returns {route, reasons: [{code, text}], flags: {...}, info_requests: [...]}"""
    reasons_info, reasons_full = [], []
    flags = {"total_loss": False, "structural": False}
    info_requests = []

    if assessment.get("status") != "ok":
        return {
            "route": FULL_REVIEW,
            "reasons": [{"code": "model_failure", "text": "The AI assessment failed, so this claim needs a full manual review. " + (assessment.get("error") or "")}],
            "flags": flags, "info_requests": [],
        }

    photos = assessment.get("photos", [])
    usable = [p for p in photos if p.get("usable")]
    unusable = [p for p in photos if not p.get("usable")]
    if photos and not usable:
        issues = sorted({p.get("issue_text") or p.get("issue") or "unusable" for p in unusable})
        reasons_info.append({"code": "photos_unusable", "text": "No usable photo: " + ", ".join(issues) + "."})
    vc = assessment.get("vehicle_check", {})
    if vc.get("match") == "no":
        reasons_info.append({"code": "vehicle_mismatch", "text": "The car in the photos doesn't match the policy: " + (vc.get("reason") or "")})
    elif vc.get("match") == "uncertain":
        reasons_full.append({"code": "vehicle_uncertain", "text": "The two AI runs disagree on whether the car matches the policy."})
    if usable and not findings and not reasons_info:
        reasons_info.append({"code": "no_damage_found", "text": "No damage is visible in the photos."})
        info_requests.append("Ask the policyholder which part of the car is damaged and for a close photo of it.")
    dc = assessment.get("description_check", {})
    if dc.get("consistent") == "no":
        reasons_full.append({"code": "description_mismatch", "text": "The damage doesn't match the accident description: " + (dc.get("reason") or "")})

    if reasons_info:
        info_requests = list(assessment.get("info_requests") or []) + info_requests
        if not info_requests:
            info_requests = ["Ask for new, sharp photos of the damaged area, taken in good light from about two metres."]
        return {"route": NEED_INFO, "reasons": reasons_info, "flags": flags, "info_requests": info_requests}

    if assessment.get("structural_suspected"):
        flags["structural"] = True
        reasons_full.append({"code": "structural", "text": "Possible structural damage: " + (assessment.get("structural_reason") or "signs seen in the photos.")})
    if not claim.get("drivable", True):
        reasons_full.append({"code": "not_drivable", "text": "The car is not drivable."})
    if claim.get("airbags_deployed"):
        reasons_full.append({"code": "airbags", "text": "The airbags deployed."})

    high = estimate["totals"]["high"]
    amount = float(settings["amount_threshold"])
    if high > amount:
        reasons_full.append({"code": "amount", "text": f"The estimate (${high:,.0f}) is above the ${amount:,.0f} limit."})
    value = float(claim.get("vehicle", {}).get("value") or 0)
    ratio = high / value if value else 0
    if value and ratio >= float(settings["total_loss_ratio"]):
        flags["total_loss"] = True
        reasons_full.append({"code": "total_loss", "text": f"Possible total loss: the estimate is {ratio:.0%} of the car's value (${value:,.0f})."})
    flags["value_ratio"] = round(ratio, 3)

    min_conf = CONFIDENCE_ORDER.index(settings["min_confidence_fast_track"])
    low_conf = [f for f in findings if CONFIDENCE_ORDER.index(f.get("confidence", "high")) < min_conf]
    if low_conf:
        names = ", ".join(sorted({f.get("part_name") or f["part"] for f in low_conf}))
        reasons_full.append({"code": "low_confidence", "text": f"The AI is unsure about: {names}."})
    if settings.get("severe_to_full_review") and any(f["severity"] == "severe" for f in findings):
        reasons_full.append({"code": "severe", "text": "At least one part is severely damaged."})
    # A bad photo among good ones doesn't change the route; the reviewer sees it as a note.
    notes = []
    if unusable:
        notes.append(f"{len(unusable)} of {len(photos)} photos couldn't be used and were left out.")

    if reasons_full:
        return {"route": FULL_REVIEW, "reasons": reasons_full, "flags": flags, "notes": notes,
                "info_requests": list(assessment.get("info_requests") or [])}
    return {
        "route": FAST_TRACK,
        "reasons": [{"code": "fast_track", "text": "Minor damage, the two AI runs agree, and the estimate is under the limit."}],
        "flags": flags, "notes": notes, "info_requests": [],
    }
