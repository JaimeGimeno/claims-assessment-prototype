"""The web service off the happy path: login gate, bad uploads, model failure, caps."""
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import assess, db, main, providers, service


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app) as c:
        yield c


@pytest.fixture(autouse=True)
def fresh_cap():
    """Each test starts with no live runs counted today."""
    db.init()
    with db.conn() as c:
        c.execute("DELETE FROM model_calls")
    yield


@pytest.fixture(scope="module")
def authed(client):
    assert client.post("/api/login", json={"password": "test-password"}).status_code == 200
    return client


def jpeg(color=(120, 120, 120), size=(800, 600), noise=True):
    img = Image.new("RGB", size, color)
    if noise:  # some texture so the photo isn't flagged as blurred
        px = img.load()
        for x in range(0, size[0], 7):
            for y in range(0, size[1], 5):
                px[x, y] = (255 - color[0], (x * 3) % 255, (y * 5) % 255)
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    return buf.getvalue()


FAKE_RUN = {
    "photos": [{"photo": 1, "view": "side", "usable": True, "issue": "none"}],
    "vehicle_seen": "grey car", "vehicle_matches_policy": "yes", "vehicle_mismatch_reason": "",
    "description_consistent": "not_provided", "description_mismatch_reason": "",
    "findings": [{"part": "front_door", "side": "left", "damage_type": "scratch", "severity": "minor", "action": "repair",
                  "paint_damaged": True, "confidence": "high", "photo": 1, "reason": "Scratches on the door."}],
    "structural_suspected": False, "structural_reason": "", "info_requests": [], "suggested_vehicle_class": "midsize_standard",
}


def fake_model(data=None, error=None):
    async def call(model, system, parts, schema, effort="medium"):
        if error:
            raise providers.ModelError(error)
        return {"data": json.loads(json.dumps(data or FAKE_RUN)), "tokens_in": 100, "tokens_out": 50, "cost_usd": 0.001, "latency_s": 0.1}
    return call


def test_nothing_is_served_without_the_password():
    with TestClient(main.app) as c:
        assert c.get("/api/claims").status_code == 401
        assert c.get("/photos/own-1").status_code == 401
        assert c.get("/api/reference").status_code == 401
        r = c.get("/", follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"] == "/login"
        page = c.get("/login")
        assert "noindex" in page.headers["x-robots-tag"] and "<script" not in page.text
        assert c.post("/login", data={"password": "nope"}, follow_redirects=False).headers["location"] == "/login?e=wrong"
        ok = c.post("/login", data={"password": "test-password"}, follow_redirects=False)
        assert ok.status_code == 303 and ok.headers["location"] == "/" and "claims_session" in ok.headers["set-cookie"]
        main._fails.clear()
        assert "Disallow: /" in c.get("/robots.txt").text


def test_login_attempts_are_limited():
    with TestClient(main.app) as c:
        main._fails.clear()
        for _ in range(5):
            assert c.post("/api/login", json={"password": "nope"}).status_code == 401
        assert c.post("/api/login", json={"password": "test-password"}).status_code == 429
        main._fails.clear()


def test_sample_claims_are_listed(authed):
    claims = authed.get("/api/claims").json()
    assert len([c for c in claims if c["sample"]]) == 24
    assert authed.get("/api/claims/NOPE").status_code == 404
    assert authed.get("/photos/own-1").headers["content-type"] == "image/jpeg"
    assert "API_KEY" not in authed.get("/photos/..%2F..%2F.env").text
    assert authed.get("/photos/up-..-..-.env").status_code == 404


def test_upload_end_to_end_with_edit_and_approval(authed, monkeypatch):
    monkeypatch.setattr(assess, "call_model", fake_model())
    r = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("car.jpg", jpeg(), "image/jpeg"))])
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    v = authed.get(f"/api/claims/{cid}").json()
    assert v["route"] == "fast_track" and v["estimate_total"] > 0 and len(v["findings"]) == 1
    fid = v["findings"][0]["id"]
    # an edit needs a reason
    assert authed.patch(f"/api/claims/{cid}/findings/{fid}", json={"severity": "severe"}).status_code == 422
    assert authed.patch(f"/api/claims/{cid}/findings/{fid}", json={"severity": "severe", "reason_code": "nope"}).status_code == 400
    v2 = authed.patch(f"/api/claims/{cid}/findings/{fid}", json={"severity": "severe", "reason_code": "wrong_severity"}).json()
    assert v2["estimate_total"] > v["estimate_total"] and v2["route"] == "full_review"
    assert v2["corrections"][0]["action"] == "edit" and v2["corrections"][0]["reason_code"] == "wrong_severity"
    # add and remove
    v3 = authed.post(f"/api/claims/{cid}/findings", json={"part": "mirror", "side": "left", "damage_type": "missing_part", "severity": "severe"}).json()
    assert len(v3["findings"]) == 2
    new_id = v3["findings"][-1]["id"]
    v4 = authed.delete(f"/api/claims/{cid}/findings/{new_id}", params={"reason_code": "not_damage"}).json()
    assert len(v4["findings"]) == 1
    # approval needs a shop
    assert authed.post(f"/api/claims/{cid}/decision", json={"action": "approve"}).status_code == 400
    v5 = authed.post(f"/api/claims/{cid}/decision", json={"action": "approve", "shop_id": "shop-1"}).json()
    assert v5["status"] == "approved" and v5["review"]["shop_id"] == "shop-1"


def test_bad_uploads_are_rejected(authed, monkeypatch):
    monkeypatch.setattr(assess, "call_model", fake_model())
    r = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("notes.jpg", b"this is not an image", "image/jpeg"))])
    assert r.status_code == 400 and "readable image" in r.json()["detail"]
    r = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("evil.svg", b"<svg onload=alert(1)></svg>", "image/svg+xml"))])
    assert r.status_code == 400
    many = [("files", (f"{i}.jpg", jpeg(), "image/jpeg")) for i in range(7)]
    assert authed.post("/api/try", data={"preset_id": "preset-mid"}, files=many).status_code == 400
    assert authed.post("/api/try", data={"preset_id": "preset-mid"}).status_code == 400
    assert authed.post("/api/try", data={"vehicle_class": "midsize_standard", "value": "abc"},
                       files=[("files", ("car.jpg", jpeg(), "image/jpeg"))]).status_code == 400


def test_dark_photo_is_caught_without_calling_the_model(authed, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the model must not be called for an unusable photo")
    monkeypatch.setattr(assess, "call_model", boom)
    r = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("dark.jpg", jpeg((4, 4, 4), noise=False), "image/jpeg"))])
    v = authed.get(f"/api/claims/{r.json()['id']}").json()
    assert v["route"] == "need_more_information" and not v["photo_list"][0]["usable"]


def test_not_a_car_goes_to_need_more_information(authed, monkeypatch):
    run = dict(FAKE_RUN, findings=[], photos=[{"photo": 1, "view": "a cat", "usable": False, "issue": "not_a_vehicle"}],
               info_requests=["a photo of the damaged car"])
    monkeypatch.setattr(assess, "call_model", fake_model(run))
    r = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("cat.jpg", jpeg(), "image/jpeg"))])
    v = authed.get(f"/api/claims/{r.json()['id']}").json()
    assert v["route"] == "need_more_information" and "not a vehicle" in v["route_reasons"][0]["text"]


def test_no_damage_goes_to_need_more_information(authed, monkeypatch):
    monkeypatch.setattr(assess, "call_model", fake_model(dict(FAKE_RUN, findings=[])))
    r = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("clean.jpg", jpeg(), "image/jpeg"))])
    v = authed.get(f"/api/claims/{r.json()['id']}").json()
    assert v["route"] == "need_more_information" and v["route_reasons"][0]["code"] == "no_damage_found" and v["estimate_total"] == 0


def test_model_failure_goes_to_full_review_with_a_clear_message(authed, monkeypatch):
    monkeypatch.setattr(assess, "call_model", fake_model(error="Couldn't reach the model."))
    with db.conn() as c:
        c.execute("DELETE FROM model_calls")
    r = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("car.jpg", jpeg(), "image/jpeg"))])
    assert r.status_code == 200
    v = authed.get(f"/api/claims/{r.json()['id']}").json()
    assert v["route"] == "full_review" and v["assessment_failed"]
    assert "Couldn't reach the model" in v["route_reasons"][0]["text"]
    # the adjuster can still build the estimate by hand
    v2 = authed.post(f"/api/claims/{v['id']}/findings", json={"part": "hood", "damage_type": "dent", "severity": "moderate"}).json()
    assert v2["estimate_total"] > 0


def test_daily_cap(authed, monkeypatch):
    monkeypatch.setattr(assess, "call_model", fake_model())
    with db.conn() as c:
        c.execute("DELETE FROM model_calls")
    for _ in range(3):
        assert authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("car.jpg", jpeg(), "image/jpeg"))]).status_code == 200
    r = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("car.jpg", jpeg(), "image/jpeg"))])
    assert r.status_code == 429 and "daily limit" in r.json()["detail"]


def test_settings_change_reroutes_and_is_logged(authed):
    assert authed.put("/api/settings", json={"amount_threshold": -5}).status_code == 400
    assert authed.put("/api/settings", json={"model": "gpt-5"}).status_code == 400
    s = authed.put("/api/settings", json={"amount_threshold": 1234}).json()
    assert s["amount_threshold"] == 1234
    assert authed.get("/api/corrections").json()[0]["action"] == "settings"
    authed.put("/api/settings", json={"amount_threshold": 3000})


def test_try_it_drafts_the_policy_car(authed, monkeypatch):
    async def fake_identify(model, jpegs):
        return {"make": "Kia", "model": "Sportage", "year": 2020, "color": "grey", "vehicle_class": "suv_standard", "identified": True, "cost_usd": 0.001}
    monkeypatch.setattr(assess, "identify_vehicle", fake_identify)
    monkeypatch.setattr(assess, "call_model", fake_model())
    r = authed.post("/api/try", data={"preset_id": "auto"}, files=[("files", ("car.jpg", jpeg(), "image/jpeg"))])
    assert r.status_code == 200, r.text
    v = authed.get(f"/api/claims/{r.json()['id']}").json()
    car = v["vehicle"]
    assert (car["make"], car["model"], car["year"], car["vehicle_class"]) == ("Kia", "Sportage", 2020, "suv_standard")
    assert car["assumed"] and 5000 < car["value"] < 36000 and v["policy_number"].startswith("POL-SAMPLE-")
    assert v["route"] == "fast_track" and v["estimate_total"] > 0


def test_try_it_still_works_if_the_car_cannot_be_identified(authed, monkeypatch):
    async def boom(model, jpegs):
        raise providers.ModelError("no")
    monkeypatch.setattr(assess, "identify_vehicle", boom)
    monkeypatch.setattr(assess, "call_model", fake_model())
    r = authed.post("/api/try", data={"preset_id": "auto"}, files=[("files", ("car.jpg", jpeg(), "image/jpeg"))])
    v = authed.get(f"/api/claims/{r.json()['id']}").json()
    assert v["vehicle"]["vehicle_class"] == "midsize_standard" and v["estimate_total"] > 0


def test_full_review_goes_through_the_agent_then_the_senior_adjuster(authed, monkeypatch):
    monkeypatch.setattr(assess, "call_model", fake_model())
    cid = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("car.jpg", jpeg(), "image/jpeg"))]).json()["id"]
    agent, senior = {"X-Role": "agent"}, {"X-Role": "senior"}
    v = authed.get(f"/api/claims/{cid}").json()
    assert v["route"] == "fast_track" and v["owner"] == "senior"  # fast-track skips the agent
    fid = v["findings"][0]["id"]
    v = authed.patch(f"/api/claims/{cid}/findings/{fid}", json={"severity": "severe", "reason_code": "wrong_severity"}, headers=agent).json()
    assert v["route"] == "full_review" and v["owner"] == "agent"
    assert v["corrections"][0]["actor"] == "agent"
    # the agent can't approve or reject; only the senior adjuster can
    assert authed.post(f"/api/claims/{cid}/decision", json={"action": "approve", "shop_id": "shop-1"}, headers=agent).status_code == 403
    assert authed.post(f"/api/claims/{cid}/decision", json={"action": "reject"}, headers=agent).status_code == 403
    # nothing to send back yet
    assert authed.post(f"/api/claims/{cid}/decision", json={"action": "send_back"}, headers=senior).status_code == 400
    v = authed.post(f"/api/claims/{cid}/decision", json={"action": "send_for_approval"}, headers=agent).json()
    assert v["status"] == "agent_checked" and v["owner"] == "senior"
    assert authed.post(f"/api/claims/{cid}/decision", json={"action": "send_for_approval"}, headers=agent).status_code == 400
    # the senior adjuster sends it back with a note, the agent sends it again, the senior approves
    v = authed.post(f"/api/claims/{cid}/decision", json={"action": "send_back", "note": "Check the door"}, headers=senior).json()
    assert v["status"] == "pending" and v["owner"] == "agent" and v["review"]["note"] == "Check the door"
    authed.post(f"/api/claims/{cid}/decision", json={"action": "send_for_approval"}, headers=agent)
    v = authed.post(f"/api/claims/{cid}/decision", json={"action": "approve", "shop_id": "shop-1"}, headers=senior).json()
    assert v["status"] == "approved" and v["owner"] is None
    assert [c["actor"] for c in v["corrections"][:2]] == ["senior", "agent"]


def test_information_request_waits_for_the_policyholder(authed, monkeypatch):
    monkeypatch.setattr(assess, "call_model", fake_model())
    cid = authed.post("/api/try", data={"preset_id": "preset-mid"}, files=[("files", ("car.jpg", jpeg(), "image/jpeg"))]).json()["id"]
    v = authed.post(f"/api/claims/{cid}/decision", json={"action": "request_info", "note": "A wider photo"}, headers={"X-Role": "agent"}).json()
    assert v["status"] == "info_requested" and v["owner"] == "policyholder"
