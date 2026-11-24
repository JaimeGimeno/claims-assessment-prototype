"""The web service: API, photo serving, login, and the built screens."""
from __future__ import annotations

import hmac
import io
import json
import threading
import time
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, TimestampSigner
from PIL import Image
from pydantic import BaseModel

from . import assess, db, imaging, refdata, routing, service
from .config import (APP_MODELS, DAILY_LIVE_RUNS, DATA_DIR, DEMO_PASSWORD, FRONTEND_DIST, MAX_PHOTOS_PER_CLAIM, MAX_UPLOAD_BYTES,
                     MODELS, SECURE_COOKIES, SESSION_SECRET, STATE_DIR, UPLOAD_DIR)

app = FastAPI(title="Claims assessment prototype", docs_url=None, redoc_url=None, openapi_url=None)

COOKIE = "claims_session"
SESSION_MAX_AGE = 7 * 24 * 3600
OPEN_PATHS = {"/login", "/api/login", "/robots.txt", "/healthz"}
LOGIN_WINDOW_S, LOGIN_MAX_FAILS = 600, 5
_fails: dict = {}


@app.on_event("startup")
def _startup() -> None:
    if not DEMO_PASSWORD or not SESSION_SECRET:
        raise RuntimeError("Set DEMO_PASSWORD and SESSION_SECRET in app/.env (see .env.example).")
    service.seed()
    threading.Thread(target=_warm_thumbnails, daemon=True).start()


def _thumb(photo_id: str, path, w: int):
    cache = STATE_DIR / "thumbs" / f"{photo_id}-{w}.jpg"
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        img = Image.open(path).convert("RGB")
        img.thumbnail((w, w * 2))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=82)
        cache.write_bytes(buf.getvalue())
    return cache


def _warm_thumbnails() -> None:
    """Makes the gallery thumbnails ahead of time so the first visit isn't slow."""
    for pid, p in refdata.photos().items():
        for w in (160, 240):
            try:
                _thumb(pid, service.photo_path(pid), w)
            except Exception:
                pass


def _signer() -> TimestampSigner:
    return TimestampSigner(SESSION_SECRET)


def _authed(request: Request) -> bool:
    token = request.cookies.get(COOKIE)
    if not token:
        return False
    try:
        _signer().unsign(token, max_age=SESSION_MAX_AGE)
        return True
    except BadSignature:
        return False


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "unknown")


@app.middleware("http")
async def gate(request: Request, call_next):
    """Nothing is served without the password: no API, no photos, no screens."""
    path = request.url.path
    if path not in OPEN_PATHS and not _authed(request):
        if path.startswith("/api/") or path.startswith("/photos/"):
            resp = JSONResponse({"detail": "Sign in first."}, status_code=401)
        else:
            resp = RedirectResponse("/login", status_code=302)
    else:
        resp = await call_next(request)
    resp.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'"
    if path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


LOGIN_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Sign in · Claims assessment</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f4f1;color:#1b1b19;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(360px,calc(100vw - 32px))}h1{font-size:20px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}p{margin:0 0 20px;color:#6a6a64}
label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
input{width:100%;height:40px;padding:0 12px;border:1px solid #cfcdc6;border-radius:8px;font:inherit;background:#fff}
input:focus{outline:2px solid #1f4fd8;outline-offset:1px;border-color:#1f4fd8}
button{width:100%;height:40px;margin-top:12px;border:0;border-radius:8px;background:#1b1b19;color:#fff;font:inherit;font-weight:500;cursor:pointer}
.err{color:#a3271f;font-size:13px;margin-top:10px;min-height:20px}
</style></head><body><main><h1>Claims assessment</h1><p>Prototype. Enter the password to continue.</p>
<form method="post" action="/login"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
<button>Sign in</button><div class="err" role="alert">__ERROR__</div></form></main>
</body></html>"""


LOGIN_ERRORS = {"wrong": "Wrong password.", "limit": "Too many attempts. Try again in a few minutes."}


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request, e: str = ""):
    if _authed(request):
        return RedirectResponse("/", status_code=302)
    return HTMLResponse(LOGIN_HTML.replace("__ERROR__", LOGIN_ERRORS.get(e, "")))


def _check_password(password: str, request: Request) -> str:
    """Returns "" when the password is right, or the error code. Counts failures per address."""
    ip, now = _client_ip(request), time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < LOGIN_WINDOW_S]
    if len(recent) >= LOGIN_MAX_FAILS:
        return "limit"
    if not hmac.compare_digest(password.encode(), DEMO_PASSWORD.encode()):
        _fails[ip] = recent + [now]
        return "wrong"
    _fails.pop(ip, None)
    return ""


def _set_session(resp: Response) -> Response:
    resp.set_cookie(COOKIE, _signer().sign(b"ok").decode(), max_age=SESSION_MAX_AGE, httponly=True, samesite="lax", secure=SECURE_COOKIES)
    return resp


@app.post("/login")
def login_form(request: Request, password: str = Form("")):
    """The sign-in page posts here as a plain form, so it needs no script."""
    err = _check_password(password, request)
    if err:
        return RedirectResponse(f"/login?e={err}", status_code=303)
    return _set_session(RedirectResponse("/", status_code=303))


class LoginBody(BaseModel):
    password: str


@app.post("/api/login")
def login(body: LoginBody, request: Request):
    err = _check_password(body.password, request)
    if err == "limit":
        raise HTTPException(429, LOGIN_ERRORS[err])
    if err:
        raise HTTPException(401, LOGIN_ERRORS[err])
    return _set_session(JSONResponse({"ok": True}))


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE)
    return resp


@app.get("/robots.txt", response_class=PlainTextResponse)
def robots():
    return "User-agent: *\nDisallow: /\n"


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"


# ------------------------------------------------------------------ reference and settings

@app.get("/api/reference")
def get_reference():
    ref = dict(refdata.reference())
    ref["routes"] = routing.ROUTE_NAMES
    ref["models"] = [{"id": m, "name": MODELS[m]["name"]} for m in APP_MODELS]
    ref["limits"] = {"max_photos": MAX_PHOTOS_PER_CLAIM, "max_upload_mb": MAX_UPLOAD_BYTES // (1024 * 1024)}
    ref["operations"] = [{"id": "refinish", "name": "Refinish"}, {"id": "pdr", "name": "Paintless dent repair"}, {"id": "repair", "name": "Repair"},
                         {"id": "refit", "name": "Refit"}, {"id": "replace", "name": "Replace"}, {"id": "polish", "name": "Polish"}]
    return ref


@app.get("/api/price-table")
def get_price_table():
    return [{"vehicle_class": k[0], "part": k[1], **v} for k, v in refdata.price_table().items()]


@app.get("/api/settings")
def get_settings():
    return db.get_settings()


class SettingsBody(BaseModel):
    amount_threshold: Optional[float] = None
    total_loss_ratio: Optional[float] = None
    min_confidence_fast_track: Optional[str] = None
    severe_to_full_review: Optional[bool] = None
    model: Optional[str] = None


@app.put("/api/settings")
def put_settings(body: SettingsBody):
    new = {k: v for k, v in body.model_dump().items() if v is not None}
    if "amount_threshold" in new and not 0 <= new["amount_threshold"] <= 100000:
        raise HTTPException(400, "The amount limit must be between 0 and 100,000.")
    if "total_loss_ratio" in new and not 0.3 <= new["total_loss_ratio"] <= 1.0:
        raise HTTPException(400, "The total-loss threshold must be between 30% and 100%.")
    if "min_confidence_fast_track" in new and new["min_confidence_fast_track"] not in refdata.CONFIDENCE_ORDER:
        raise HTTPException(400, "Unknown confidence level.")
    if "model" in new and new["model"] not in APP_MODELS:
        raise HTTPException(400, "Unknown model.")
    old = db.get_settings()
    changes = [{"field": k, "from": old.get(k), "to": v} for k, v in new.items() if old.get(k) != v]
    if changes:
        db.put_settings(new)
        db.log_correction(None, "settings", "", changes, "", "")
    return db.get_settings()


@app.get("/api/usage")
def usage():
    return {"live_runs_today": db.live_runs_today(), "daily_cap": DAILY_LIVE_RUNS, **db.usage_totals()}


# ------------------------------------------------------------------ claims

@app.get("/api/claims")
def list_claims():
    return [service.claim_view(c["id"], full=False) for c in db.list_claims()]


@app.get("/api/claims/{claim_id}")
def get_claim(claim_id: str):
    v = service.claim_view(claim_id)
    if v is None:
        raise HTTPException(404, "Claim not found.")
    return v


def _need_claim(claim_id: str) -> dict:
    c = db.get_claim(claim_id)
    if c is None:
        raise HTTPException(404, "Claim not found.")
    return c


def _need_reason(code: str) -> None:
    if code not in {r["id"] for r in refdata.reference()["edit_reasons"]}:
        raise HTTPException(400, "Pick a reason for the change.")


class FindingEdit(BaseModel):
    part: Optional[str] = None
    side: Optional[str] = None
    damage_type: Optional[str] = None
    severity: Optional[str] = None
    operation_override: Optional[str] = None
    price_override: Optional[float] = None
    clear_overrides: bool = False  # back to the rule's operation and the table's price
    reason_code: str
    note: str = ""


def _role(request: Request) -> str:
    """Which role the visitor is viewing as. The demo has one password and a role switch, not accounts,
    so this is a label for the change log and for the role rules below, not a security control."""
    r = request.headers.get("x-role", "")
    return r if r in ("agent", "senior") else "senior"


def _validate_fields(d: dict) -> None:
    if d.get("part") is not None and d["part"] not in refdata.parts():
        raise HTTPException(400, "Unknown part.")
    if d.get("damage_type") is not None and d["damage_type"] not in refdata.damage_types():
        raise HTTPException(400, "Unknown damage type.")
    if d.get("severity") is not None and d["severity"] not in refdata.SEVERITY_ORDER:
        raise HTTPException(400, "Unknown severity.")
    if d.get("side") is not None and d["side"] not in refdata.SIDES:
        raise HTTPException(400, "Unknown side.")
    if d.get("operation_override") not in (None, "", "refinish", "pdr", "repair", "refit", "replace", "polish"):
        raise HTTPException(400, "Unknown operation.")
    if d.get("price_override") is not None and not 0 <= d["price_override"] <= 100000:
        raise HTTPException(400, "The line price must be between 0 and 100,000.")


@app.patch("/api/claims/{claim_id}/findings/{finding_id}")
def patch_finding(claim_id: str, finding_id: str, body: FindingEdit, request: Request):
    _need_claim(claim_id)
    _need_reason(body.reason_code)
    changes = {k: v for k, v in body.model_dump().items() if k not in ("reason_code", "note", "clear_overrides") and v is not None}
    _validate_fields(changes)
    if body.clear_overrides:
        changes.update({"operation_override": None, "price_override": None})
    try:
        service.edit_finding(claim_id, finding_id, changes, body.reason_code, body.note[:500], _role(request))
    except (StopIteration, TypeError):
        raise HTTPException(404, "Finding not found.")
    return service.claim_view(claim_id)


class FindingAdd(BaseModel):
    part: str
    side: str = "unknown"
    damage_type: str
    severity: str
    photo_id: Optional[str] = None
    reason_code: str = "missed_damage"
    note: str = ""


@app.post("/api/claims/{claim_id}/findings")
def post_finding(claim_id: str, body: FindingAdd, request: Request):
    _need_claim(claim_id)
    _need_reason(body.reason_code)
    _validate_fields(body.model_dump())
    service.add_finding(claim_id, body.model_dump(), body.reason_code, body.note[:500], _role(request))
    return service.claim_view(claim_id)


@app.delete("/api/claims/{claim_id}/findings/{finding_id}")
def delete_finding(claim_id: str, finding_id: str, reason_code: str, request: Request, note: str = ""):
    _need_claim(claim_id)
    _need_reason(reason_code)
    try:
        service.remove_finding(claim_id, finding_id, reason_code, note[:500], _role(request))
    except (StopIteration, TypeError):
        raise HTTPException(404, "Finding not found.")
    return service.claim_view(claim_id)


class Decision(BaseModel):
    action: str
    shop_id: Optional[str] = None
    note: str = ""


@app.post("/api/claims/{claim_id}/decision")
def post_decision(claim_id: str, body: Decision, request: Request):
    _need_claim(claim_id)
    if body.action not in service.STATUS_AFTER:
        raise HTTPException(400, "Unknown action.")
    role = _role(request)
    review = db.get_review(claim_id) or {}
    status = review.get("status", "pending")
    if body.action in ("approve", "reject", "send_back") and role != "senior":
        raise HTTPException(403, "Only the senior adjuster approves, rejects or sends a claim back.")
    if body.action == "approve":
        if body.shop_id not in {s["id"] for s in refdata.reference()["shops"]}:
            raise HTTPException(400, "Pick an approved shop to authorise.")
        if not review.get("findings"):
            raise HTTPException(400, "There is nothing to authorise: the estimate has no lines.")
    if body.action == "send_for_approval":
        if status != "pending":
            raise HTTPException(400, "Only a claim that is waiting for a check can be sent for approval.")
        if not review.get("findings"):
            raise HTTPException(400, "There is nothing to approve: the estimate has no lines.")
    if body.action == "send_back" and status != "agent_checked":
        raise HTTPException(400, "Only a claim that an agent has checked can be sent back.")
    service.decide(claim_id, body.action, body.shop_id, body.note[:1000], role)
    return service.claim_view(claim_id)


@app.post("/api/claims/{claim_id}/assess")
async def post_assess(claim_id: str, request: Request):
    """Runs the AI live on this claim. The reviewer's edits are replaced by the new result."""
    claim = _need_claim(claim_id)
    try:
        await service.run_assessment(claim, db.get_settings()["model"], live=True)
    except service.CapReached:
        raise HTTPException(429, f"The daily limit of {DAILY_LIVE_RUNS} live runs has been reached. Stored results still work.")
    db.log_correction(claim_id, "rerun", "", [], "", "Live AI assessment", _role(request))
    return service.claim_view(claim_id)


# ------------------------------------------------------------------ try it


@app.get("/api/samples")
def samples():
    out = []
    pre = service.PRECOMPUTED
    for p in refdata.photos().values():
        lab, tier = refdata.labels_for(p["id"])
        out.append({"id": p["id"], "url": f"/photos/{p['id']}", "source": p["source"], "tier": p["tier"],
                    "label_tier": tier, "car": p.get("car", ""), "view": p.get("view", ""),
                    "stored_result": (pre / f"photo-{p['id']}.json").exists()})
    return out


@app.post("/api/try")
async def try_it(
    photo_ids: str = Form(""), files: List[UploadFile] = File(default=[]),
    preset_id: str = Form(""), make: str = Form(""), model: str = Form(""), year: str = Form(""),
    vehicle_class: str = Form(""), value: str = Form(""), description: str = Form(""),
    drivable: str = Form("true"), airbags: str = Form("false"), run_live: str = Form("false"),
):
    ids = [x for x in photo_ids.split(",") if x]
    files = [f for f in files if f and f.filename]
    if not ids and not files:
        raise HTTPException(400, "Pick at least one sample photo or upload one.")
    if len(ids) + len(files) > MAX_PHOTOS_PER_CLAIM:
        raise HTTPException(400, f"A claim can have at most {MAX_PHOTOS_PER_CLAIM} photos.")
    for pid in ids:
        if pid not in refdata.photos():
            raise HTTPException(400, "Unknown sample photo.")

    ref = refdata.reference()
    preset = next((p for p in ref["vehicle_presets"] if p["id"] == preset_id), None)
    auto_car = preset_id == "auto"
    if auto_car:
        # A try-out has no policy, so the AI drafts the policy car from the photos (below).
        vehicle = service.drafted_vehicle({})
    elif preset:
        vehicle = {k: preset[k] for k in ("make", "model", "year", "vehicle_class", "value")}
    else:
        if vehicle_class not in {c["id"] for c in ref["vehicle_classes"]}:
            raise HTTPException(400, "Pick the car, or its class and value.")
        try:
            val = float(value)
            yr = int(year) if year else None
        except ValueError:
            raise HTTPException(400, "The car's value and year must be numbers.")
        if not 500 <= val <= 500000:
            raise HTTPException(400, "The car's value must be between $500 and $500,000.")
        vehicle = {"make": make.strip()[:40], "model": model.strip()[:40], "year": yr, "vehicle_class": vehicle_class, "value": val}

    claim_id = db.next_try_id()
    saved = []
    for i, f in enumerate(files, start=1):
        data = await f.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(400, f"{f.filename}: the file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
        try:
            img = imaging.load_image(data)
        except imaging.BadImage as e:
            raise HTTPException(400, f"{f.filename}: {e}")
        pid = f"up-{claim_id.lower()}-{i}"
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        # stored re-encoded: bounded size, and no location or device data
        (UPLOAD_DIR / f"{pid}.jpg").write_bytes(imaging.to_jpeg(img, max_side=2000))
        saved.append(pid)

    claim = {
        "id": claim_id, "policy_number": "", "policyholder": "Try it", "vehicle": vehicle,
        "accident_description": description.strip()[:600], "drivable": drivable == "true", "airbags_deployed": airbags == "true",
        "photos": ids + saved, "sample": False, "source": "upload" if saved else "sample_photos",
    }
    if auto_car:
        claim["policy_number"] = f"POL-SAMPLE-{claim_id[4:]}"
        claim["policyholder"] = "Sample policyholder"
        drafted = service.stored_vehicle(ids[0]) if len(ids) == 1 and not saved else None
        if drafted is None and db.live_runs_today() < DAILY_LIVE_RUNS:
            try:
                jpegs, _ = service.load_photos(claim["photos"])
                drafted = await assess.identify_vehicle(db.get_settings()["model"], jpegs)
            except Exception:
                drafted = None  # the claim still works, with a generic car
        claim["vehicle"] = vehicle = service.drafted_vehicle(drafted or {})
    db.put_claim(claim)

    stored = service.PRECOMPUTED / f"photo-{ids[0]}.json" if len(ids) == 1 and not saved else None
    # a stored result was made with no car, so it can only stand in when no car was chosen
    if stored is not None and stored.exists() and run_live != "true" and not claim["accident_description"] and auto_car:
        a = json.loads(stored.read_text())
        db.put_assessment(claim_id, a, live=False)
        db.put_review(claim_id, [dict(x) for x in a.get("findings", [])])
    else:
        try:
            await service.run_assessment(claim, db.get_settings()["model"], live=True)
        except service.CapReached:
            raise HTTPException(429, f"The daily limit of {DAILY_LIVE_RUNS} live runs has been reached. Sample photos with a stored result still work.")
    return {"id": claim_id}


# ------------------------------------------------------------------ evaluation, log, photos

@app.get("/api/eval")
def get_eval():
    f = DATA_DIR / "eval" / "summary.json"
    return json.loads(f.read_text()) if f.exists() else {"available": False}


@app.get("/api/corrections")
def get_corrections():
    return db.corrections()


@app.get("/photos/{photo_id}")
def get_photo(photo_id: str, w: int = 0):
    path = service.photo_path(photo_id)
    if path is None or not path.exists():
        raise HTTPException(404, "Photo not found.")
    headers = {"Cache-Control": "private, max-age=86400"}
    if w and 64 <= w <= 1600:
        cache = _thumb(photo_id, path, w)
        return FileResponse(cache, media_type="image/jpeg", headers=headers)
    return FileResponse(path, media_type="image/jpeg", headers=headers)


# ------------------------------------------------------------------ screens

if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.get("/{path:path}")
def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(404, "Not found.")
    f = FRONTEND_DIST / path
    if path and f.is_file() and FRONTEND_DIST in f.resolve().parents:
        return FileResponse(f)
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(index, headers={"Cache-Control": "no-store"})
    return HTMLResponse("<p>The screens haven't been built yet. Run <code>npm run build</code> in <code>frontend/</code>.</p>")
