"""Pricing: fixed rules that turn findings into estimate lines. No AI here.

Every number comes from the price table and the labour rates, so the same damage
always gets the same price and each line can be traced and challenged.
"""
from __future__ import annotations

from typing import Optional

from .refdata import SEVERITY_ORDER, parts, price_table, reference

SCRATCH_REFINISH_SHARE = 0.6  # a minor scratch is a spot refinish, not the whole panel
POLISH_HOURS = 0.3


def choose_operation(part_id: str, damage_type: str, severity: str, action: str = "", paint_damaged: bool = True) -> str:
    """The rule that picks the repair operation. Returns one of:
    polish, refinish, pdr, repair, refit, replace."""
    part = parts()[part_id]
    if damage_type == "flat_tyre":
        return "replace"
    if damage_type in ("shattered_glass", "broken_lamp"):
        return "replace"
    if damage_type == "missing_part":
        return "refit" if action == "repair" and not part["replace_only"] else "replace"
    if part["replace_only"]:
        return "polish" if damage_type == "scratch" and severity == "minor" else "replace"
    if damage_type == "scratch":
        return "refinish" if severity in ("minor", "moderate") else "repair"
    if damage_type == "dent":
        if severity == "minor":
            return "pdr" if part["metal"] and not paint_damaged and _row_any(part_id)["pdr_price"] else "repair"
        if severity == "moderate":
            return "repair"
        return "repair" if action == "repair" else "replace"
    if damage_type == "crack":
        if severity == "minor":
            return "repair"
        return "replace"
    return "repair"


def _row_any(part_id: str) -> dict:
    return price_table()[("midsize_standard", part_id)]


def price_operation(part_id: str, operation: str, severity: str, vehicle_class: str) -> dict:
    """One estimate line for an operation on a part, for a vehicle class."""
    part = parts()[part_id]
    row = price_table()[(vehicle_class, part_id)]
    rates = reference()["labour_rates"]
    labour_type = "body"
    part_price = 0.0
    labour_hours = 0.0
    paint_hours = 0.0
    sublet = 0.0

    if operation == "replace":
        part_price = row["part_price"]
        labour_hours = row["replace_hours"]
        labour_type = part["replace_labour"]
        paint_hours = row["refinish_hours"] if part["paintable"] else 0.0
    elif operation == "refit":
        labour_hours = row["replace_hours"]
        labour_type = part["replace_labour"]
    elif operation == "repair":
        sev = severity if severity in SEVERITY_ORDER else "moderate"
        hours = row["repair_hours"].get(sev)
        labour_hours = hours if hours is not None else row["replace_hours"]
        paint_hours = row["refinish_hours"] if part["paintable"] else 0.0
    elif operation == "refinish":
        share = SCRATCH_REFINISH_SHARE if severity == "minor" else 1.0
        paint_hours = round(row["refinish_hours"] * share, 1)
    elif operation == "pdr":
        sublet = row["pdr_price"] or 0.0
    elif operation == "polish":
        labour_hours = POLISH_HOURS

    labour_cost = labour_hours * rates[labour_type]
    paint_labour = paint_hours * rates["refinish"]
    paint_materials = paint_hours * rates["paint_materials_per_refinish_hour"]
    total = part_price + labour_cost + paint_labour + paint_materials + sublet
    return {
        "part": part_id,
        "part_name": part["name"],
        "operation": operation,
        "part_price": round(part_price, 2),
        "labour_hours": round(labour_hours, 1),
        "labour_type": labour_type,
        "labour_rate": rates[labour_type],
        "labour_cost": round(labour_cost, 2),
        "paint_hours": round(paint_hours, 1),
        "paint_labour": round(paint_labour, 2),
        "paint_materials": round(paint_materials, 2),
        "sublet": round(sublet, 2),
        "total": round(total, 2),
    }


def price_finding(f: dict, vehicle_class: str) -> dict:
    """Prices one finding. Returns the line for the most likely operation, plus a
    low and a high figure when repair versus replace (or the severity) is unclear."""
    if f.get("operation_override"):
        op = f["operation_override"]
        line = price_operation(f["part"], op, f["severity"], vehicle_class)
        low = high = line["total"]
    else:
        op = choose_operation(f["part"], f["damage_type"], f["severity"], f.get("action", ""), f.get("paint_damaged", True))
        line = price_operation(f["part"], op, f["severity"], vehicle_class)
        options = [line["total"]]
        # the other severity the two runs disagreed on
        alt = f.get("severity_alt")
        if alt and alt != f["severity"]:
            alt_op = choose_operation(f["part"], f["damage_type"], alt, f.get("action", ""), f.get("paint_damaged", True))
            options.append(price_operation(f["part"], alt_op, alt, vehicle_class)["total"])
        # the model said it could not tell repair from replace
        if f.get("action") == "unclear" and not parts()[f["part"]]["replace_only"]:
            for other in ("repair", "replace"):
                if other != op:
                    options.append(price_operation(f["part"], other, f["severity"], vehicle_class)["total"])
        low, high = min(options), max(options)
    if f.get("price_override") is not None:
        line["total"] = low = high = round(float(f["price_override"]), 2)
        line["price_overridden"] = True
    line.update({"finding_id": f.get("id"), "side": f.get("side", ""), "damage_type": f["damage_type"],
                 "severity": f["severity"], "low": round(low, 2), "high": round(high, 2), "is_range": round(low, 2) != round(high, 2)})
    return line


def build_estimate(findings: list, vehicle_class: str) -> dict:
    lines = [price_finding(f, vehicle_class) for f in findings]
    def s(k):
        return round(sum(l[k] for l in lines), 2)
    total = s("total")
    low = round(sum(l["low"] for l in lines), 2)
    high = round(sum(l["high"] for l in lines), 2)
    labour_by_type: dict = {}
    for l in lines:
        if l["labour_cost"]:
            labour_by_type[l["labour_type"]] = round(labour_by_type.get(l["labour_type"], 0) + l["labour_cost"], 2)
    return {
        "lines": lines,
        "totals": {
            "parts": s("part_price"),
            "labour": s("labour_cost"),
            "labour_by_type": labour_by_type,
            "labour_hours": round(sum(l["labour_hours"] for l in lines), 1),
            "paint_labour": s("paint_labour"),
            "paint_hours": round(sum(l["paint_hours"] for l in lines), 1),
            "paint_materials": s("paint_materials"),
            "sublet": s("sublet"),
            "total": total,
            "low": low,
            "high": high,
            "is_range": low != high,
        },
        "note": "Sample prices and labour hours. Labour rates are published medians. Tax and deductible are not included.",
    }


def reference_estimate(findings: list, vehicle_class: str) -> Optional[float]:
    """Total for a list of label findings, priced with the same rules."""
    return build_estimate(findings, vehicle_class)["totals"]["total"]
