"""Stores AI results so the sample claims and sample photos open instantly.

  python scripts/precompute.py claims --model claude-sonnet-5-5   # from the cached eval runs
  python scripts/precompute.py photos --model claude-sonnet-5-5   # from the cached single-photo runs

The stored files are real model output from the same code path the live run uses.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import assess, refdata, service  # noqa: E402
from backend.config import DATA_DIR  # noqa: E402
from run_eval import BUDGET_USD, RAW, add_spend, claims, load_runs, spend_total  # noqa: E402

OUT = DATA_DIR / "precomputed"


def pack(runs: list, photo_ids: list, gates: list, model: str) -> dict:
    a = assess.merge_runs([r["data"] for r in runs], photo_ids, gates)
    a.update({"model": model, "cost_usd": round(sum(r["cost_usd"] for r in runs), 5), "latency_s": max(r["latency_s"] for r in runs),
              "tokens_in": sum(r["tokens_in"] for r in runs), "tokens_out": sum(r["tokens_out"] for r in runs), "runs_failed": 0})
    return a


def do_claims(model: str) -> None:
    OUT.mkdir(exist_ok=True)
    for c in claims():
        runs = load_runs(model, "with_description", c["id"])
        if len(runs) < 2:
            print("missing runs for", c["id"])
            continue
        _, gates = service.load_photos(c["photos"])
        (OUT / f"{c['id']}.json").write_text(json.dumps(pack(runs, c["photos"], gates, model), indent=1))
    print("claims stored:", len(list(OUT.glob("CLM-*.json"))))


def do_photos(model: str) -> None:
    """Packs the cached two-run results for each sample photo (see scripts/ai_label.py run)."""
    OUT.mkdir(exist_ok=True)
    n = 0
    for pid in refdata.photos():
        runs = []
        for k in (1, 2):
            f = RAW / model / "photo" / f"{pid}_run{k}.json"
            if f.exists():
                runs.append(json.loads(f.read_text()))
        if len(runs) < 2:
            continue
        _, gates = service.load_photos([pid])
        (OUT / f"photo-{pid}.json").write_text(json.dumps(pack(runs, [pid], gates, model), indent=1))
        n += 1
    print("photos stored:", n)


async def do_vehicles(model: str, concurrency: int = 6) -> None:
    """Drafts the policy car for every sample photo, so a try-out with one sample photo opens instantly."""
    OUT.mkdir(exist_ok=True)
    sem = asyncio.Semaphore(concurrency)

    async def one(pid):
        raw = RAW / model / "vehicle" / f"{pid}.json"
        if not raw.exists():
            async with sem:
                if spend_total() >= BUDGET_USD:
                    return
                jpegs, _ = service.load_photos([pid])
                try:
                    v = await assess.identify_vehicle(model, jpegs)
                except Exception as e:  # noqa: BLE001
                    print("FAILED", pid, e)
                    return
                raw.parent.mkdir(parents=True, exist_ok=True)
                raw.write_text(json.dumps(v))
                add_spend(model, v["cost_usd"], "sample_photo_runs")
        v = json.loads(raw.read_text())
        v.pop("cost_usd", None)
        (OUT / f"vehicle-{pid}.json").write_text(json.dumps(v))

    await asyncio.gather(*[one(p) for p in refdata.photos()])
    print("vehicles stored:", len(list(OUT.glob("vehicle-*.json"))))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["claims", "photos", "vehicles"])
    ap.add_argument("--model", default="claude-sonnet-5-5")
    args = ap.parse_args()
    if args.what == "claims":
        do_claims(args.model)
    elif args.what == "photos":
        do_photos(args.model)
    else:
        asyncio.run(do_vehicles(args.model))
