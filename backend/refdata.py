"""Reference data: parts, damage types, price table, labour rates, shops.

In production the price table is the insurer's licensed estimating database and
the rates are the ones agreed with its shop network. Here they are files.
"""
from __future__ import annotations

import csv
import json
from functools import lru_cache

from .config import DATA_DIR


@lru_cache(maxsize=1)
def reference() -> dict:
    return json.loads((DATA_DIR / "reference.json").read_text())


@lru_cache(maxsize=1)
def parts() -> dict:
    return {p["id"]: p for p in reference()["parts"]}


@lru_cache(maxsize=1)
def damage_types() -> dict:
    return {d["id"]: d for d in reference()["damage_types"]}


@lru_cache(maxsize=1)
def price_table() -> dict:
    """(vehicle_class, part) -> row with numbers parsed."""
    out = {}
    with (DATA_DIR / "price_table.csv").open() as f:
        for r in csv.DictReader(f):
            def num(k):
                return float(r[k]) if r[k] not in ("", None) else None
            out[(r["vehicle_class"], r["part"])] = {
                "part_price": num("part_price"),
                "replace_hours": num("replace_hours"),
                "repair_hours": {"minor": num("repair_hours_minor"), "moderate": num("repair_hours_moderate"), "severe": num("repair_hours_severe")},
                "refinish_hours": num("refinish_hours") or 0.0,
                "pdr_price": num("pdr_price"),
            }
    return out


@lru_cache(maxsize=1)
def photos() -> dict:
    return {p["id"]: p for p in json.loads((DATA_DIR / "photos.json").read_text())}


@lru_cache(maxsize=1)
def human_labels() -> dict:
    return json.loads((DATA_DIR / "labels_human.json").read_text())


def ai_labels() -> dict:
    p = DATA_DIR / "labels_ai.json"
    return json.loads(p.read_text()) if p.exists() else {}


def labels_for(photo_id: str):
    """Returns (label, tier) for a sample photo, or (None, None)."""
    h = human_labels().get(photo_id)
    if h:
        return h, "human"
    a = ai_labels().get(photo_id)
    if a:
        return a, "ai"
    return None, None


SEVERITY_ORDER = ["minor", "moderate", "severe"]
CONFIDENCE_ORDER = ["low", "medium", "high"]
SIDES = ["left", "right", "center", "unknown"]
