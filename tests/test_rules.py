"""Pricing, routing, the two-run merge and the label comparison. No model calls."""
from backend import assess, evaluation, pricing, routing
from backend.config import DEFAULT_SETTINGS

CLAIM = {"vehicle": {"vehicle_class": "midsize_standard", "value": 20000}, "drivable": True, "airbags_deployed": False}


def finding(part="front_door", sev="minor", dtype="dent", conf="high", **kw):
    return dict({"id": "f1", "part": part, "side": "left", "damage_type": dtype, "severity": sev, "action": "repair",
                 "paint_damaged": True, "confidence": conf}, **kw)


def ok_assessment(findings, **kw):
    return dict({"status": "ok", "photos": [{"photo_id": "p1", "usable": True}], "findings": findings,
                 "vehicle_check": {"match": "yes"}, "description_check": {"consistent": "yes"}}, **kw)


def route(findings, claim=CLAIM, settings=DEFAULT_SETTINGS, **kw):
    est = pricing.build_estimate(findings, claim["vehicle"]["vehicle_class"])
    return routing.route_claim(claim, ok_assessment(findings, **kw), findings, est, settings)


# ---- pricing
def test_operation_rules():
    assert pricing.choose_operation("front_door", "scratch", "minor") == "refinish"
    assert pricing.choose_operation("front_door", "dent", "minor", paint_damaged=False) == "pdr"
    assert pricing.choose_operation("front_door", "dent", "minor", paint_damaged=True) == "repair"
    assert pricing.choose_operation("front_bumper", "dent", "minor", paint_damaged=False) == "repair"  # plastic: no PDR
    assert pricing.choose_operation("front_door", "dent", "severe") == "replace"
    assert pricing.choose_operation("headlamp", "broken_lamp", "minor") == "replace"
    assert pricing.choose_operation("rear_bumper", "missing_part", "moderate", action="repair") == "refit"


def test_line_is_traceable_to_the_table():
    line = pricing.price_operation("front_bumper", "replace", "severe", "midsize_standard")
    # part 420 + 1.8 h body at $68 + 2.8 paint hours at $68 labour and $50 materials
    assert line["part_price"] == 420
    assert line["labour_cost"] == round(1.8 * 68, 2)
    assert line["total"] == round(420 + 1.8 * 68 + 2.8 * 68 + 2.8 * 50, 2)


def test_same_damage_same_price():
    a = pricing.build_estimate([finding(sev="moderate")], "midsize_standard")["totals"]["total"]
    b = pricing.build_estimate([finding(sev="moderate")], "midsize_standard")["totals"]["total"]
    assert a == b


def test_luxury_costs_more():
    std = pricing.build_estimate([finding(sev="severe")], "midsize_standard")["totals"]["total"]
    lux = pricing.build_estimate([finding(sev="severe")], "midsize_luxury")["totals"]["total"]
    assert lux > std


def test_range_when_runs_disagree_or_action_unclear():
    t = pricing.build_estimate([finding(sev="severe", severity_alt="moderate")], "midsize_standard")["totals"]
    assert t["is_range"] and t["low"] < t["high"]
    t = pricing.build_estimate([finding(sev="moderate", action="unclear")], "midsize_standard")["totals"]
    assert t["is_range"]
    t = pricing.build_estimate([finding(sev="moderate")], "midsize_standard")["totals"]
    assert not t["is_range"]


# ---- routing
def test_fast_track():
    r = route([finding(sev="minor", dtype="scratch")])
    assert r["route"] == routing.FAST_TRACK


def test_full_review_reasons():
    assert "low_confidence" in [x["code"] for x in route([finding(conf="low")])["reasons"]]
    assert "severe" in [x["code"] for x in route([finding(sev="severe")])["reasons"]]
    assert "structural" in [x["code"] for x in route([finding()], structural_suspected=True)["reasons"]]
    not_drivable = dict(CLAIM, drivable=False)
    assert "not_drivable" in [x["code"] for x in route([finding()], claim=not_drivable)["reasons"]]
    airbags = dict(CLAIM, airbags_deployed=True)
    assert "airbags" in [x["code"] for x in route([finding()], claim=airbags)["reasons"]]


def test_amount_threshold_is_adjustable():
    f = [finding(sev="moderate"), finding(part="rear_door", sev="moderate", id="f2")]
    assert route(f)["route"] == routing.FAST_TRACK
    low = dict(DEFAULT_SETTINGS, amount_threshold=500)
    r = route(f, settings=low)
    assert r["route"] == routing.FULL_REVIEW and "amount" in [x["code"] for x in r["reasons"]]


def test_total_loss_flag():
    cheap_car = {"vehicle": {"vehicle_class": "midsize_standard", "value": 1500}, "drivable": True}
    r = route([finding(sev="severe", action="replace")], claim=cheap_car)
    assert r["flags"]["total_loss"] and r["route"] == routing.FULL_REVIEW


def test_need_more_information():
    a = {"status": "ok", "photos": [{"photo_id": "p1", "usable": False, "issue_text": "blurred"}], "findings": [],
         "vehicle_check": {"match": "yes"}, "description_check": {}}
    r = routing.route_claim(CLAIM, a, [], pricing.build_estimate([], "midsize_standard"), DEFAULT_SETTINGS)
    assert r["route"] == routing.NEED_INFO and r["info_requests"]
    r = route([], vehicle_check={"match": "no", "reason": "red van"})
    assert r["route"] == routing.NEED_INFO
    r = route([])  # usable photos, nothing found
    assert r["route"] == routing.NEED_INFO and r["reasons"][0]["code"] == "no_damage_found"


def test_model_failure_goes_to_full_review():
    a = {"status": "failed", "error": "Couldn't reach the model."}
    r = routing.route_claim(CLAIM, a, [], pricing.build_estimate([], "midsize_standard"), DEFAULT_SETTINGS)
    assert r["route"] == routing.FULL_REVIEW and r["reasons"][0]["code"] == "model_failure"


# ---- merging the two runs
def run(findings, usable=True, **kw):
    return dict({"photos": [{"photo": 1, "usable": usable, "issue": "none" if usable else "blurry", "view": ""}],
                 "findings": findings, "vehicle_matches_policy": "yes", "description_consistent": "yes"}, **kw)


def raw(part="front_door", side="left", sev="moderate", conf="high", dtype="dent", action="repair"):
    return {"part": part, "side": side, "damage_type": dtype, "severity": sev, "action": action,
            "paint_damaged": True, "confidence": conf, "photo": 1, "reason": ""}


def test_merge_agreement_and_disagreement():
    m = assess.merge_runs([run([raw()]), run([raw()])], ["p1"], [{"ok": True}])
    assert m["findings"][0]["agreement"] == "both_runs" and m["findings"][0]["confidence"] == "high"
    m = assess.merge_runs([run([raw(sev="severe")]), run([raw(sev="moderate")])], ["p1"], [{"ok": True}])
    f = m["findings"][0]
    assert f["severity"] == "severe" and f["severity_alt"] == "moderate" and f["confidence"] == "medium"
    m = assess.merge_runs([run([raw(), raw(part="hood", side="center", conf="medium")]), run([raw()])], ["p1"], [{"ok": True}])
    hood = next(f for f in m["findings"] if f["part"] == "hood")
    assert hood["agreement"] == "one_run" and hood["confidence"] == "low"
    # seen once and unsure: dropped
    m = assess.merge_runs([run([raw(), raw(part="hood", side="center", conf="low")]), run([raw()])], ["p1"], [{"ok": True}])
    assert [f["part"] for f in m["findings"]] == ["front_door"]


def test_merge_photo_unusable_only_if_all_runs_say_so():
    m = assess.merge_runs([run([], usable=False), run([], usable=False)], ["p1"], [{"ok": True}])
    assert not m["photos"][0]["usable"]
    m = assess.merge_runs([run([], usable=False), run([], usable=True)], ["p1"], [{"ok": True}])
    assert m["photos"][0]["usable"] and m["photos"][0]["runs_disagree"]
    m = assess.merge_runs([run([raw()]), run([raw()])], ["p1"], [{"ok": False, "issue": "too_dark"}])
    assert not m["photos"][0]["usable"] and m["findings"] == []


def test_merge_ignores_values_outside_our_lists():
    m = assess.merge_runs([run([raw(part="spoiler")]), run([raw(part="spoiler")])], ["p1"], [{"ok": True}])
    assert m["findings"] == []


def test_structural_flag_if_any_run_sees_it():
    m = assess.merge_runs([run([raw()], structural_suspected=True, structural_reason="pillar"), run([raw()])], ["p1"], [{"ok": True}])
    assert m["structural_suspected"] and m["structural_runs"] == "1 of 2"


# ---- comparing with labels
def test_compare_uses_alternatives_and_optionals():
    ref = evaluation.claim_reference([{"findings": [
        {"part": "front_door", "side": "left", "damage_type": "dent", "severity": "severe", "also_ok_severity": ["moderate"]},
        {"part": "rocker_panel", "side": "left", "damage_type": "dent", "severity": "minor", "optional": True},
        {"part": "rear_door", "side": "left", "damage_type": "dent", "severity": "severe"},
    ]}])
    ai = [finding(sev="moderate"), finding(part="hood", id="f2")]
    c = evaluation.compare(ai, ref)["counts"]
    assert c["required"] == 2 and c["found"] == 1 and c["missed"] == 1 and c["extra"] == 1 and c["severity_ok"] == 1


def test_compare_wrong_side_counts_as_found_with_side_wrong():
    ref = evaluation.claim_reference([{"findings": [{"part": "front_door", "side": "left", "damage_type": "dent", "severity": "minor"}]}])
    c = evaluation.compare([finding(side="right")], ref)["counts"]
    assert c["found"] == 1 and c["side_ok"] == 0


def test_reference_total_has_no_gap_for_accepted_alternatives():
    ref = evaluation.claim_reference([{"findings": [
        {"part": "front_door", "side": "left", "damage_type": "dent", "severity": "severe", "also_ok_severity": ["moderate"]}]}])
    ai = [finding(sev="moderate")]
    cmp = evaluation.compare(ai, ref)
    assert evaluation.reference_total(cmp, "midsize_standard") == pricing.build_estimate(ai, "midsize_standard")["totals"]["total"]
