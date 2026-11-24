"""Compares AI findings with reference labels. Used by the eval script and by the
"reference" panel in the app, so both show the same judgement.

Labels can carry accepted alternatives (a second severity, type or part) and
optional findings (uncertain ones that don't count as a miss).
"""
from __future__ import annotations

from typing import List, Optional

from .pricing import build_estimate
from .refdata import SEVERITY_ORDER, parts


def claim_reference(photo_labels: List[dict]) -> dict:
    """Merges per-photo labels into one reference for the claim. The same part seen
    in two photos is one finding; the more severe label wins and alternatives add up."""
    merged = {}
    for lab in photo_labels:
        for f in lab.get("findings", []):
            key = (f["part"], f.get("side", ""))
            if key not in merged:
                merged[key] = dict(f, also_ok_severity=list(f.get("also_ok_severity", [])),
                                   also_ok_damage_type=list(f.get("also_ok_damage_type", [])), also_ok_part=list(f.get("also_ok_part", [])))
                merged[key]["optional"] = bool(f.get("optional"))
                continue
            m = merged[key]
            m["optional"] = m["optional"] and bool(f.get("optional"))
            sevs = {m["severity"], f["severity"], *m["also_ok_severity"], *f.get("also_ok_severity", [])}
            top = max([m["severity"], f["severity"]], key=SEVERITY_ORDER.index)
            m["also_ok_severity"] = sorted(sevs - {top}, key=SEVERITY_ORDER.index)
            m["severity"] = top
            types = {m["damage_type"], f["damage_type"], *m["also_ok_damage_type"], *f.get("also_ok_damage_type", [])}
            # a dent with scratches is a dent
            order = ["dent", "crack", "missing_part", "broken_lamp", "shattered_glass", "flat_tyre", "scratch"]
            main = next(t for t in order if t in {m["damage_type"], f["damage_type"]})
            m["damage_type"] = main
            m["also_ok_damage_type"] = sorted(types - {main})
            m["also_ok_part"] = sorted({*m["also_ok_part"], *f.get("also_ok_part", [])})
    labs = [l for l in photo_labels if not l.get("photo_unusable")]
    return {
        "findings": list(merged.values()),
        "structural_suspected": any(l.get("structural_suspected") for l in photo_labels),
        "structural_uncertain": any(l.get("structural_uncertain") for l in photo_labels),
        "ambiguous": any(l.get("ambiguous") for l in photo_labels),
        "all_photos_unusable": bool(photo_labels) and not labs,
    }


def _side_ok(a: str, b: str) -> bool:
    loose = ("", "unknown", "center")
    return a == b or a in loose or b in loose


def compare(ai_findings: List[dict], ref: dict) -> dict:
    """Pairs AI findings with reference findings and judges each pair."""
    refs = ref["findings"]
    used, rows = set(), []
    remaining = list(enumerate(ai_findings))

    def find(r, strict_side):
        for i, f in remaining:
            if i in used:
                continue
            part_ok = f["part"] == r["part"] or f["part"] in r.get("also_ok_part", [])
            if not part_ok:
                continue
            if strict_side and f.get("side") != r.get("side"):
                continue
            if not strict_side and not _side_ok(f.get("side", ""), r.get("side", "")):
                continue
            return i, f
        return None

    def find_other_side(r):
        for i, f in remaining:
            if i not in used and (f["part"] == r["part"] or f["part"] in r.get("also_ok_part", [])):
                return i, f
        return None

    for r in sorted(refs, key=lambda x: bool(x.get("optional"))):
        hit = find(r, True) or find(r, False)
        side_wrong = False
        if not hit and r.get("side") in ("left", "right"):
            # right part, wrong side: counted as found, with the side marked wrong
            hit = find_other_side(r)
            side_wrong = hit is not None
        if hit:
            i, f = hit
            used.add(i)
            sev_ok = f["severity"] == r["severity"] or f["severity"] in r.get("also_ok_severity", []) or \
                (f.get("severity_alt") is not None and f.get("severity_alt") == r["severity"])
            type_ok = f["damage_type"] == r["damage_type"] or f["damage_type"] in r.get("also_ok_damage_type", [])
            rows.append({"status": "matched", "ref": r, "ai": f, "severity_ok": sev_ok, "type_ok": type_ok,
                         "side_ok": not side_wrong, "optional": bool(r.get("optional"))})
        else:
            rows.append({"status": "optional_not_found" if r.get("optional") else "missed", "ref": r, "ai": None,
                         "optional": bool(r.get("optional"))})
    for i, f in remaining:
        if i not in used:
            rows.append({"status": "extra", "ref": None, "ai": f})

    required = [x for x in rows if x["ref"] is not None and not x["optional"]]
    found = [x for x in required if x["status"] == "matched"]
    matched = [x for x in rows if x["status"] == "matched"]
    extra = [x for x in rows if x["status"] == "extra"]
    return {
        "rows": rows,
        "counts": {
            "required": len(required), "found": len(found), "missed": len(required) - len(found),
            "extra": len(extra), "ai_total": len(ai_findings), "matched": len(matched),
            "severity_ok": sum(1 for x in matched if x["severity_ok"]),
            "type_ok": sum(1 for x in matched if x["type_ok"]),
            "side_ok": sum(1 for x in matched if x["side_ok"]),
        },
    }


def reference_total(cmp: dict, vehicle_class: str) -> float:
    """Prices the reference with the same rules. To keep the gap fair:
    - a required finding is priced at the label's severity, or at the AI's severity
      when that severity is an accepted alternative;
    - an optional finding is priced only if the AI also reported it."""
    priced = []
    for row in cmp["rows"]:
        r = row["ref"]
        if r is None:
            continue
        if row["status"] == "matched":
            f = row["ai"]
            sev = f["severity"] if row["severity_ok"] and f["severity"] in [r["severity"], *r.get("also_ok_severity", [])] else r["severity"]
            dtype = f["damage_type"] if row["type_ok"] else r["damage_type"]
            priced.append({"part": f["part"] if f["part"] in [r["part"], *r.get("also_ok_part", [])] else r["part"],
                           "damage_type": dtype, "severity": sev, "action": f.get("action", ""), "paint_damaged": f.get("paint_damaged", True)})
        elif row["status"] == "missed":
            priced.append({"part": r["part"], "damage_type": r["damage_type"], "severity": r["severity"], "action": "", "paint_damaged": True})
    return build_estimate(priced, vehicle_class)["totals"]["total"]


def label_view(ref: dict) -> list:
    """Reference findings with display names, for the app."""
    return [dict(f, part_name=parts()[f["part"]]["name"]) for f in ref["findings"]]
