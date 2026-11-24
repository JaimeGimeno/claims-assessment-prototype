"""One-off data preparation. Builds everything under app/data/ from the raw inputs.

Inputs (outside the repo): the Kaggle "Coco Car Damage Detection" set, Jaime's own
photos, and the two human label files. Outputs are committed, so the app runs
without this script.

Run:  python scripts/build_data.py <photos_dir>
"""
from __future__ import annotations

import csv
import json
import random
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw

APP = Path(__file__).resolve().parent.parent
DATA = APP / "data"
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else APP.parent / "photos"

# ---------------------------------------------------------------- reference data

PARTS = [
    # id, name, paintable, replace_only, labour type for replacing, structural, metal
    ("front_bumper", "Front bumper", True, False, "body", False, False),
    ("grille", "Grille", False, True, "body", False, False),
    ("hood", "Hood", True, False, "body", False, True),
    ("headlamp", "Headlamp", False, True, "body", False, False),
    ("fender", "Fender", True, False, "body", False, True),
    ("windshield", "Windshield", False, True, "body", False, False),
    ("front_door", "Front door", True, False, "body", False, True),
    ("rear_door", "Rear door", True, False, "body", False, True),
    ("mirror", "Mirror", False, True, "body", False, False),
    ("side_window", "Side window", False, True, "body", False, False),
    ("rocker_panel", "Rocker panel", True, False, "structural", True, True),
    ("quarter_panel", "Quarter panel", True, False, "structural", True, True),
    ("roof", "Roof", True, False, "structural", True, True),
    ("trunk_lid", "Trunk lid or liftgate", True, False, "body", False, True),
    ("rear_bumper", "Rear bumper", True, False, "body", False, False),
    ("tail_lamp", "Tail lamp", False, True, "body", False, False),
    ("back_glass", "Back glass", False, True, "body", False, False),
    ("wheel", "Wheel or tyre", False, True, "mechanical", False, False),
]

DAMAGE_TYPES = [
    ("scratch", "Scratch"),
    ("dent", "Dent"),
    ("crack", "Crack"),
    ("shattered_glass", "Shattered glass"),
    ("broken_lamp", "Broken lamp"),
    ("missing_part", "Missing or detached part"),
    ("flat_tyre", "Flat tyre"),
]

SEVERITIES = [
    ("minor", "Minor", "Paint only or a small dent. Repaired without replacing the part."),
    ("moderate", "Moderate", "A clear dent or deep scratches. The panel is repaired and repainted."),
    ("severe", "Severe", "Creased, torn or broken. The part is normally replaced."),
]

# Base sample values for a mid-size, standard car. NOT real market data: real part
# prices and labour hours come from licensed estimating databases.
# part: (part_price, replace_h, repair_h minor/moderate/severe, refinish_h, pdr_price)
BASE = {
    "front_bumper": (420, 1.8, (1.0, 2.5, 4.0), 2.8, None),
    "rear_bumper": (400, 1.7, (1.0, 2.5, 4.0), 2.7, None),
    "grille": (180, 0.5, None, 0.0, None),
    "hood": (520, 1.2, (1.5, 3.5, 6.0), 3.2, 150),
    "headlamp": (380, 0.6, None, 0.0, None),
    "tail_lamp": (190, 0.4, None, 0.0, None),
    "fender": (310, 1.9, (1.5, 3.0, 5.0), 2.2, 125),
    "front_door": (640, 3.4, (1.5, 3.5, 6.0), 2.6, 125),
    "rear_door": (600, 3.2, (1.5, 3.5, 6.0), 2.5, 125),
    "mirror": (220, 0.6, None, 0.0, None),
    "side_window": (190, 1.2, None, 0.0, None),
    "rocker_panel": (290, 6.5, (2.0, 4.0, 7.0), 1.6, None),
    "quarter_panel": (680, 11.0, (2.0, 4.5, 8.0), 2.8, 150),
    "roof": (780, 12.0, (2.0, 5.0, 9.0), 3.6, 175),
    "trunk_lid": (560, 1.6, (1.5, 3.5, 6.0), 2.6, 125),
    "windshield": (420, 2.2, None, 0.0, None),
    "back_glass": (380, 2.0, None, 0.0, None),
    "wheel": (210, 0.5, None, 0.0, None),
}

# Vehicle classes. Multipliers are assumptions; the published figures only imply
# that a luxury mid-size SUV costs about 1.6x a small standard car to repair.
CLASSES = [
    # id, name, part price multiplier, labour hours multiplier, refinish multiplier
    ("small_standard", "Small car, standard", 0.85, 1.0, 1.0),
    ("small_luxury", "Small car, luxury", 1.35, 1.1, 1.0),
    ("midsize_standard", "Mid-size car, standard", 1.0, 1.0, 1.0),
    ("midsize_luxury", "Mid-size car, luxury", 1.6, 1.1, 1.0),
    ("suv_standard", "SUV, standard", 1.15, 1.0, 1.1),
    ("suv_luxury", "SUV, luxury", 1.85, 1.1, 1.1),
    ("pickup_standard", "Pickup, standard", 1.2, 1.0, 1.1),
    ("pickup_luxury", "Pickup, luxury", 1.9, 1.1, 1.1),
]

RATES = {
    # Real published figures (see README): insurer-paid median body rate 2026, frame
    # rate, mechanical rate, and average paint materials per refinish hour.
    "body": 68.0,
    "refinish": 68.0,  # assumption: same as body; the survey doesn't report it
    "structural": 93.0,
    "mechanical": 127.0,
    "paint_materials_per_refinish_hour": 50.0,
}

SHOPS = [  # made up
    {"id": "shop-1", "name": "Northside Collision Center", "city": "Columbus, OH", "structural": True},
    {"id": "shop-2", "name": "Riverbend Auto Body", "city": "Columbus, OH", "structural": False},
    {"id": "shop-3", "name": "Summit Paint & Body", "city": "Dublin, OH", "structural": False},
    {"id": "shop-4", "name": "Keystone Frame & Collision", "city": "Westerville, OH", "structural": True},
]

VEHICLE_PRESETS = [  # for uploads and samples with no policy behind them; values are sample
    {"id": "preset-small", "make": "Toyota", "model": "Yaris", "year": 2019, "vehicle_class": "small_standard", "value": 13500},
    {"id": "preset-mid", "make": "Honda", "model": "Accord", "year": 2020, "vehicle_class": "midsize_standard", "value": 21000},
    {"id": "preset-mid-lux", "make": "BMW", "model": "3 Series", "year": 2020, "vehicle_class": "midsize_luxury", "value": 29500},
    {"id": "preset-suv", "make": "Toyota", "model": "RAV4", "year": 2021, "vehicle_class": "suv_standard", "value": 26000},
    {"id": "preset-suv-lux", "make": "Audi", "model": "Q5", "year": 2021, "vehicle_class": "suv_luxury", "value": 36500},
    {"id": "preset-pickup", "make": "Ford", "model": "F-150", "year": 2019, "vehicle_class": "pickup_standard", "value": 31000},
    {"id": "preset-old", "make": "Ford", "model": "Focus", "year": 2008, "vehicle_class": "small_standard", "value": 3800},
]

EDIT_REASONS = [
    ("wrong_part", "Wrong part"),
    ("wrong_damage_type", "Wrong damage type"),
    ("wrong_severity", "Wrong severity"),
    ("repair_vs_replace", "Repair vs replace"),
    ("missed_damage", "Missed damage"),
    ("not_damage", "Not damage (reflection, dirt, old damage)"),
    ("price_adjustment", "Price adjustment"),
    ("other", "Other"),
]


def write_reference() -> None:
    ref = {
        "note": "Sample reference data for the prototype. Labour rates are real published "
        "figures; part prices, labour hours, class multipliers, shops and vehicle values are sample data.",
        "currency": "USD",
        "parts": [
            {"id": p[0], "name": p[1], "paintable": p[2], "replace_only": p[3], "replace_labour": p[4], "structural": p[5], "metal": p[6]}
            for p in PARTS
        ],
        "damage_types": [{"id": d[0], "name": d[1]} for d in DAMAGE_TYPES],
        "severities": [{"id": s[0], "name": s[1], "meaning": s[2]} for s in SEVERITIES],
        "vehicle_classes": [{"id": c[0], "name": c[1]} for c in CLASSES],
        "labour_rates": RATES,
        "shops": SHOPS,
        "vehicle_presets": VEHICLE_PRESETS,
        "edit_reasons": [{"id": r[0], "name": r[1]} for r in EDIT_REASONS],
    }
    (DATA / "reference.json").write_text(json.dumps(ref, indent=1))

    with (DATA / "price_table.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            ["vehicle_class", "part", "part_price", "replace_hours", "repair_hours_minor", "repair_hours_moderate",
             "repair_hours_severe", "refinish_hours", "pdr_price", "source"]
        )
        for cid, _, pm, hm, rm in CLASSES:
            for pid, (price, rep_h, repair, refin, pdr) in BASE.items():
                rh = [round(h * hm, 1) for h in repair] if repair else ["", "", ""]
                w.writerow([
                    cid, pid, round(price * pm / 5) * 5, round(rep_h * hm, 1), *rh,
                    round(refin * rm, 1) if refin else 0.0, pdr if pdr else "", "sample",
                ])


# ---------------------------------------------------------------- photos and labels

PART_IDS = {p[1]: p[0] for p in PARTS}
TYPE_IDS = {"Scratch": "scratch", "Dent": "dent", "Crack": "crack", "Shattered glass": "shattered_glass",
            "Broken lamp": "broken_lamp", "Missing part": "missing_part", "Flat tyre": "flat_tyre"}

# Licence plates to cover in Jaime's photos: (photo number, box). Found by colour, then checked by eye.
PLATES = {
    1: [(0, 608, 44, 642)],
    4: [(488, 1076, 846, 1178)],
    5: [(900, 1012, 1166, 1134)],
    6: [(26, 716, 142, 848)],
    7: [(330, 540, 376, 656)],
    10: [(548, 1078, 884, 902, 900, 1016, 562, 1182), (336, 82, 390, 116)],
    11: [(12, 672, 222, 846, 230, 936, 16, 772)],
    16: [(566, 852, 750, 918)],
}


def norm_finding(f: dict) -> dict:
    out = {
        "part": PART_IDS[f["part"]],
        "side": f.get("side") or "",
        "damage_type": TYPE_IDS[f["type"]],
        "severity": f["severity"].lower(),
    }
    if f.get("also_ok_part"):
        out["also_ok_part"] = [PART_IDS[p] for p in f["also_ok_part"]]
    if f.get("also_ok_type"):
        out["also_ok_damage_type"] = [TYPE_IDS[t] for t in f["also_ok_type"]]
    if f.get("also_ok_severity"):
        out["also_ok_severity"] = [s.lower() for s in f["also_ok_severity"]]
    if f.get("optional"):
        out["optional"] = True
    if f.get("note"):
        out["note"] = f["note"]
    return out


def build_photos() -> dict:
    pdir = DATA / "photos"
    (pdir / "kaggle").mkdir(parents=True, exist_ok=True)
    (pdir / "own").mkdir(parents=True, exist_ok=True)
    photos, labels, outlines = [], {}, {}

    kaggle_human = {}
    for x in json.loads((SRC / "labelling" / "eval-labels.json").read_text()):
        split, name = x["photo"].split("/")
        kaggle_human[f"k-{split}-{name[:-4]}"] = x

    part_names = {}
    all_kaggle = []
    for split in ("train", "val", "test"):
        sdir = SRC / "coco-car-damage" / split
        dmg = par = None
        if split != "test":
            dmg = json.loads((sdir / f"COCO_{split}_annos.json").read_text())
            par = json.loads((sdir / f"COCO_mul_{split}_annos.json").read_text())
            part_names = {c["id"]: c["name"] for c in par["categories"]}
        for jpg in sorted(sdir.glob("*.jpg"), key=lambda p: int(p.stem)):
            pid = f"k-{split}-{jpg.stem}"
            shutil.copy(jpg, pdir / "kaggle" / f"{split}-{jpg.name}")
            all_kaggle.append((pid, split, jpg.name))
            if dmg:
                did = {i["file_name"]: i["id"] for i in dmg["images"]}.get(jpg.name)
                pid_ = {i["file_name"]: i["id"] for i in par["images"]}.get(jpg.name)
                outlines[pid] = {
                    "damage": [a["segmentation"][0] for a in dmg["annotations"] if a["image_id"] == did],
                    "parts": [
                        {"part": part_names[a["category_id"]], "bbox": a["bbox"]}
                        for a in par["annotations"] if a["image_id"] == pid_
                    ],
                }

    # Tiers. Human-checked first; then hold back 12 for prompt writing (the 8 with no
    # dataset labels plus 4 picked at random); the rest get AI labels.
    rng = random.Random(11)
    labelled_rest = [p for p, s, _ in all_kaggle if s != "test" and p not in kaggle_human]
    dev_extra = set(rng.sample(labelled_rest, 4))
    for pid, split, name in all_kaggle:
        if pid in kaggle_human:
            tier = "human"
        elif split == "test" or pid in dev_extra:
            tier = "dev"
        else:
            tier = "ai"
        photos.append({"id": pid, "file": f"kaggle/{split}-{name}", "source": "kaggle", "tier": tier})

    for pid, x in kaggle_human.items():
        labels[pid] = {
            "findings": [norm_finding(f) for f in x["findings"]],
            "structural_suspected": bool(x.get("structural_suspected")),
            "structural_uncertain": bool(x.get("structural_uncertain")),
            "ambiguous": bool(x.get("ambiguous")),
            "labelled_by": x["labelled_by"],
        }

    for x in json.loads((SRC / "own" / "own-labels.json").read_text()):
        n = x["n"]
        pid = f"own-{n}"
        im = Image.open(SRC / "own" / f"{n}.jpg").convert("RGB")
        d = ImageDraw.Draw(im)
        for box in PLATES.get(n, []):
            if len(box) == 4:
                d.rounded_rectangle(box, radius=8, fill=(38, 38, 40))
            else:  # slanted plate: polygon of corner points
                d.polygon(list(zip(box[0::2], box[1::2])), fill=(38, 38, 40))
        im.save(pdir / "own" / f"{n}.jpg", quality=88)
        photos.append({"id": pid, "file": f"own/{n}.jpg", "source": "own", "tier": "human", "car": x.get("car", ""), "view": x.get("view", "")})
        labels[pid] = {
            "findings": [norm_finding(f) for f in x["findings"]],
            "structural_suspected": bool(x.get("structural_suspected")),
            "ambiguous": bool(x.get("ambiguous")),
            "photo_unusable": bool(x.get("photo_unusable")),
            "also_ok_usable": bool(x.get("also_ok_route")),
            "labelled_by": x["labelled_by"],
            "note": x.get("note", ""),
        }
        if x.get("expected_route") == "need_more_information" and not x.get("photo_unusable"):
            labels[pid]["photo_unusable"] = True  # Jaime would ask for another photo

    (DATA / "photos.json").write_text(json.dumps(photos, indent=1))
    (DATA / "labels_human.json").write_text(json.dumps(labels, indent=1))
    (DATA / "dataset_outlines.json").write_text(json.dumps(outlines))
    return {p["id"]: p for p in photos}


# ---------------------------------------------------------------- claims (sample data)

def K(split: str, n: int) -> str:
    return f"k-{split}-{n}"


# Photos and damage labels are real. Everything else on a claim is sample data:
# policy number, policyholder, year, value, description. Make and model are read
# from the badge where it shows in the photo and assigned where it doesn't.
CLAIMS = [
    # own photos: three cars
    dict(photos=["own-1", "own-2", "own-3", "own-4", "own-5"], make="Tesla", model="Model 3", year=2021, color="black",
         cls="midsize_luxury", value=27500, holder="Daniel Whitaker",
         desc="Scraped a concrete pillar while reversing out of a parking space. Marks on the rear left corner, and I think the front left too."),
    dict(photos=["own-6", "own-7", "own-8", "own-9"], make="Toyota", model="Auris", year=2009, color="blue",
         cls="small_standard", value=4900, holder="Priya Raman",
         desc="Another car scraped along the right side in a car park and drove off. Damage on the doors and the rear corner."),
    dict(photos=["own-10", "own-11", "own-12", "own-13", "own-14", "own-15"], make="Toyota", model="Auris", year=2009, color="blue",
         cls="small_standard", value=4900, holder="Priya Raman",
         desc="Found the car with a dent between the two doors on the left side, and small marks on the front bumper."),
    dict(photos=["own-16"], make="BMW", model="3 Series Coupe", year=2011, color="grey",
         cls="midsize_luxury", value=9800, holder="Marcus Oyelaran",
         desc="Someone bumped into the front of the car while it was parked."),
    # Kaggle photos: one photo per claim, in the order they were labelled
    dict(photos=[K("train", 17)], make="Volkswagen", model="Polo", year=2012, color="silver", cls="small_standard", value=6800,
         holder="Hannah Lindqvist", desc="Hit on the driver's side by a car pulling out of a side street. Both doors are pushed in."),
    dict(photos=[K("train", 51)], make="Volkswagen", model="Golf", year=2002, color="silver", cls="small_standard", value=2600,
         holder="Olivier Marchand", desc="Ran into the back of a van at low speed. The front right corner took the hit."),
    dict(photos=[K("train", 79)], make="Peugeot", model="207", year=2010, color="grey", cls="small_standard", value=4700,
         holder="Sofia Castellano", desc="Scraped a wall with the rear corner while parking."),
    dict(photos=[K("train", 49)], make="Kia", model="Carnival", year=2008, color="silver", cls="suv_standard", value=5200,
         holder="Tomás Herrera", desc="Reversed into a bollard. Dent on the rear bumper corner."),
    dict(photos=[K("train", 16)], make="Seat", model="Leon", year=2011, color="white", cls="small_standard", value=7400,
         holder="Lucía Ferrer", desc="A car scraped along the passenger side in a garage. Doors and sill are marked."),
    dict(photos=[K("train", 6)], make="Chevrolet", model="Aveo", year=2014, color="silver", cls="small_standard", value=6100,
         holder="Rafael Domínguez", desc="Clipped a painted post with the front corner while turning into a driveway."),
    dict(photos=[K("val", 62)], make="Skoda", model="Fabia", year=2004, color="green", cls="small_standard", value=2300,
         holder="Marta Kowalczyk", desc="Scraped against a garage pillar along the rear right side."),
    dict(photos=[K("train", 63)], make="Kia", model="Carens", year=2007, color="silver", cls="suv_standard", value=3400,
         holder="Ibrahim Saleh", desc="Rear-ended at a traffic light by a delivery van.", drivable=False),
    dict(photos=[K("train", 68)], make="Mazda", model="3", year=2016, color="dark grey", cls="small_standard", value=11500,
         holder="Chloe Bennett", desc="Hit a low concrete block with the passenger door while pulling out."),
    dict(photos=[K("train", 25)], make="BMW", model="3 Series Touring", year=2008, color="silver", cls="midsize_luxury", value=6500,
         holder="Stefan Albrecht", desc="Collision with a truck on the driver's side at a junction. The car was towed.",
         drivable=False, airbags=True),
    dict(photos=[K("train", 36)], make="Volkswagen", model="Golf", year=2010, color="grey", cls="small_standard", value=8200,
         holder="Emma Vasseur", desc="Rear-ended in slow traffic. Tailgate and bumper are damaged."),
    dict(photos=[K("train", 44)], make="Ford", model="Focus", year=2006, color="dark grey", cls="small_standard", value=3100,
         holder="Javier Montoro", desc="Backed into a lamp post. Rear left corner is crushed."),
    dict(photos=[K("train", 73)], make="Honda", model="Civic", year=2004, color="silver", cls="small_standard", value=3600,
         holder="Naomi Fischer", desc="Sideswiped at the rear left while parked on the street."),
    dict(photos=[K("train", 20)], make="Volkswagen", model="Golf", year=2011, color="grey", cls="small_standard", value=8900,
         holder="Pieter de Graaf", desc="Hit a gate post with the front left corner."),
    dict(photos=[K("val", 3)], make="Seat", model="Altea", year=2009, color="white", cls="small_standard", value=5300,
         holder="Carmen Ibáñez", desc="Touched a tow bar while reversing. Marks on the rear bumper."),
    dict(photos=[K("train", 2)], make="Toyota", model="Fortuner", year=2012, color="silver", cls="suv_standard", value=17500,
         holder="Arjun Mehta", desc="A car reversed into the rear left corner in a supermarket car park."),
    dict(photos=[K("val", 1)], make="Chevrolet", model="Cobalt", year=2007, color="gold", cls="small_standard", value=4200,
         holder="Grace Sullivan", desc="Backed into a pole. Deep dent in the rear bumper corner."),
    dict(photos=[K("train", 27)], make="Saturn", model="Ion", year=2004, color="green", cls="small_standard", value=2400,
         holder="Derek Lawson", desc="Front-end collision with the car ahead on a wet road. The hood won't close.", drivable=False),
    dict(photos=[K("train", 18)], make="Seat", model="Ibiza", year=2012, color="white", cls="small_standard", value=7200,
         holder="Elena Robles", desc="T-boned on the passenger side at a crossing.", drivable=False, airbags=True),
    dict(photos=[K("val", 32)], make="Audi", model="A3", year=2001, color="dark blue", cls="small_luxury", value=2900,
         holder="Víctor Salgado", desc="Rear-ended while stopped at a roundabout.", drivable=False),
]


def write_claims(photos: dict) -> None:
    out = []
    for i, c in enumerate(CLAIMS, start=1):
        for p in c["photos"]:
            assert p in photos and photos[p]["tier"] == "human", p
        out.append({
            "id": f"CLM-{1000 + i}",
            "policy_number": f"POL-{48210 + i * 37}",
            "policyholder": c["holder"],
            "vehicle": {"make": c["make"], "model": c["model"], "year": c["year"], "color": c["color"],
                        "vehicle_class": c["cls"], "value": c["value"]},
            "accident_description": c["desc"],
            "drivable": c.get("drivable", True),
            "airbags_deployed": c.get("airbags", False),
            "photos": c["photos"],
            "sample": True,
        })
    (DATA / "claims.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    write_reference()
    ph = build_photos()
    write_claims(ph)
    tiers = {}
    for p in ph.values():
        tiers[p["tier"]] = tiers.get(p["tier"], 0) + 1
    print("photos", len(ph), tiers, "claims", len(CLAIMS))
