"""Storage: one SQLite file. Claims, assessments, the reviewer's working copy of the
findings, the corrections log, settings and a record of model calls."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, List, Optional

from .config import DB_PATH, DEFAULT_SETTINGS, STATE_DIR, UPLOAD_DIR

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS assessments (claim_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at REAL NOT NULL, live INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (claim_id TEXT PRIMARY KEY, findings TEXT NOT NULL, status TEXT NOT NULL, shop_id TEXT, note TEXT, decided_at REAL);
CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, claim_id TEXT, action TEXT NOT NULL,
    finding TEXT, changes TEXT, reason_code TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, day TEXT NOT NULL, claim_id TEXT, model TEXT,
    tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, ok INTEGER);
"""


@contextmanager
def conn():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with _lock:
        c = sqlite3.connect(DB_PATH)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()


def init() -> None:
    with conn() as c:
        c.executescript(SCHEMA)
        # added later: who made the change (claims agent or senior adjuster)
        if "actor" not in {r["name"] for r in c.execute("PRAGMA table_info(corrections)")}:
            c.execute("ALTER TABLE corrections ADD COLUMN actor TEXT")


# ---- claims
def put_claim(claim: dict) -> None:
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO claims (id, data, created_at) VALUES (?, ?, COALESCE((SELECT created_at FROM claims WHERE id = ?), ?))",
                  (claim["id"], json.dumps(claim), claim["id"], time.time()))


def get_claim(claim_id: str) -> Optional[dict]:
    with conn() as c:
        r = c.execute("SELECT data, created_at FROM claims WHERE id = ?", (claim_id,)).fetchone()
    if not r:
        return None
    d = json.loads(r["data"])
    d["created_at"] = r["created_at"]
    return d


def list_claims() -> List[dict]:
    with conn() as c:
        rows = c.execute("SELECT data, created_at FROM claims ORDER BY created_at DESC, id").fetchall()
    out = []
    for r in rows:
        d = json.loads(r["data"])
        d["created_at"] = r["created_at"]
        out.append(d)
    return out


def next_try_id() -> str:
    with conn() as c:
        n = c.execute("SELECT COUNT(*) FROM claims WHERE id LIKE 'TRY-%'").fetchone()[0]
    return f"TRY-{2001 + n}"


# ---- assessments and reviews
def put_assessment(claim_id: str, data: dict, live: bool) -> None:
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO assessments (claim_id, data, created_at, live) VALUES (?, ?, ?, ?)",
                  (claim_id, json.dumps(data), time.time(), 1 if live else 0))


def get_assessment(claim_id: str) -> Optional[dict]:
    with conn() as c:
        r = c.execute("SELECT data, created_at, live FROM assessments WHERE claim_id = ?", (claim_id,)).fetchone()
    if not r:
        return None
    d = json.loads(r["data"])
    d["assessed_at"] = r["created_at"]
    d["live"] = bool(r["live"])
    return d


def put_review(claim_id: str, findings: list, status: str = "pending", shop_id: str = None, note: str = None, decided_at: float = None) -> None:
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO reviews (claim_id, findings, status, shop_id, note, decided_at) VALUES (?, ?, ?, ?, ?, ?)",
                  (claim_id, json.dumps(findings), status, shop_id, note, decided_at))


def get_review(claim_id: str) -> Optional[dict]:
    with conn() as c:
        r = c.execute("SELECT * FROM reviews WHERE claim_id = ?", (claim_id,)).fetchone()
    if not r:
        return None
    return {"findings": json.loads(r["findings"]), "status": r["status"], "shop_id": r["shop_id"], "note": r["note"], "decided_at": r["decided_at"]}


# ---- corrections log
def log_correction(claim_id: Optional[str], action: str, finding: str = "", changes: Any = None, reason_code: str = "", note: str = "",
                   actor: str = "") -> None:
    with conn() as c:
        c.execute("INSERT INTO corrections (ts, claim_id, action, finding, changes, reason_code, note, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                  (time.time(), claim_id, action, finding, json.dumps(changes or []), reason_code, note or "", actor or ""))


def corrections(claim_id: Optional[str] = None, limit: int = 500) -> List[dict]:
    q = "SELECT * FROM corrections" + (" WHERE claim_id = ?" if claim_id else "") + " ORDER BY id DESC LIMIT ?"
    args = (claim_id, limit) if claim_id else (limit,)
    with conn() as c:
        rows = c.execute(q, args).fetchall()
    return [{"id": r["id"], "ts": r["ts"], "claim_id": r["claim_id"], "action": r["action"], "finding": r["finding"],
             "changes": json.loads(r["changes"] or "[]"), "reason_code": r["reason_code"], "note": r["note"], "actor": r["actor"] or ""} for r in rows]


# ---- settings
def get_settings() -> dict:
    out = dict(DEFAULT_SETTINGS)
    with conn() as c:
        for r in c.execute("SELECT key, value FROM settings"):
            if r["key"] in out:
                out[r["key"]] = json.loads(r["value"])
    return out


def put_settings(values: dict) -> None:
    with conn() as c:
        for k, v in values.items():
            c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, json.dumps(v)))


# ---- model calls (cost and the daily cap)
def log_model_call(claim_id: str, model: str, tokens_in: int, tokens_out: int, cost: float, ok: bool) -> None:
    with conn() as c:
        c.execute("INSERT INTO model_calls (ts, day, claim_id, model, tokens_in, tokens_out, cost_usd, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                  (time.time(), time.strftime("%Y-%m-%d", time.gmtime()), claim_id, model, tokens_in, tokens_out, cost, 1 if ok else 0))


def live_runs_today() -> int:
    with conn() as c:
        return c.execute("SELECT COUNT(*) FROM model_calls WHERE day = ?", (time.strftime("%Y-%m-%d", time.gmtime()),)).fetchone()[0]


def usage_totals() -> dict:
    with conn() as c:
        r = c.execute("SELECT COUNT(*) n, COALESCE(SUM(cost_usd), 0) cost FROM model_calls").fetchone()
    return {"live_runs": r["n"], "cost_usd": round(r["cost"], 4)}
