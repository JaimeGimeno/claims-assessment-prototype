# Claims assessment prototype

A working prototype of an AI-assisted motor claims flow: photos of a damaged car go in, and an adjuster gets an itemised repair estimate to check, correct and approve.

The AI does one thing: it reads the photos and says what is damaged and how badly. Prices and routing are fixed rules. A person approves every claim.

## What it does

1. **Photo check.** A computed check rejects photos that are far too dark or small. The AI then judges whether each photo is usable and whether the car matches the policy.
2. **Damage assessment.** The AI returns findings in a fixed format: part, side, damage type, severity, repair or replace, confidence, source photo and a one-line reason. It can only answer with parts and damage types from our lists. It runs twice, and the two runs are merged.
3. **Estimate.** Each finding is priced from a price table: part, labour hours and paint. No AI is involved.
4. **Routing.** Rules send the claim to fast-track, full review or need more information, and show the reasons. The thresholds are adjustable.
5. **Review.** Two people, shown with a role switch at the top right (the demo has no accounts). A fast-track claim goes straight to the senior adjuster for one-click approval. A full-review claim is first checked by a claims agent, who edits any line, adds or removes damage and sends it on; the senior adjuster then approves and authorises a shop, sends it back, or rejects. For a claim that needs more information, the agent asks the policyholder. Every change needs a one-click reason and is logged with who made it.

On "Try it", a separate small AI step first drafts a sample policy car (make, model, year, class and a sample value) from the photos, because a real claim always arrives with a policy.

## Run it

Needs Python 3.9 or newer and Node 20 or newer.

```bash
cp .env.example .env        # then fill in ANTHROPIC_API_KEY, DEMO_PASSWORD and SESSION_SECRET
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
(cd frontend && npm ci && npm run build)
.venv/bin/uvicorn backend.main:app --port 8000
```

Open http://127.0.0.1:8000 and sign in with `DEMO_PASSWORD`. The 24 sample claims open from stored AI results, so they work without a model key. "Run AI live" and uploads need the key.

With Docker: `docker compose up --build` (see `docker-compose.yml`; it expects an external proxy network, or remove that block to run it alone).

Tests: `.venv/bin/pip install pytest && .venv/bin/python -m pytest`. They cover the pricing and routing rules, the merge of the two runs, and the cases off the happy path: a dark photo, a photo that isn't a car, a car with no damage, a model failure, bad uploads, the login limit and the daily cap. No test calls a model.

## Layout

| Path | What it is |
|---|---|
| `backend/assess.py` | The prompt, the fixed output format, and the merge of the two runs |
| `backend/pricing.py` | Rules that turn a finding into an estimate line |
| `backend/routing.py` | Rules that pick the route and give the reasons |
| `backend/evaluation.py` | Compares AI findings with reference labels |
| `backend/providers.py` | Model calls for Claude, Gemini and OpenAI |
| `backend/imaging.py` | Safe image decoding, resizing, the computed quality check |
| `backend/service.py`, `db.py`, `main.py` | Orchestration, SQLite storage, the web API and login |
| `frontend/` | The screens (React and TypeScript) |
| `data/` | Reference data, sample claims, labels, photos, stored results, eval results |
| `scripts/` | Data preparation, the eval, the AI labelling, storing results |

## What is real and what is sample data

| Data | Status |
|---|---|
| Photos | Real. 78 from the public "Coco Car Damage Detection" set on Kaggle (CC0), 16 taken for this project. Licence plates are covered in both sets, and a few bystanders' faces in the public set (`scripts/cover_plates.py`). The stored AI results were computed before the public set's plates were covered |
| Damage labels on 36 photos | Checked by a person (see "Labels" below) |
| Labour rates (`data/reference.json`) | Real published US figures for 2026: $68 an hour for body work, $93 structural, $127 mechanical, about $50 of paint materials per refinish hour |
| Part prices, labour hours, class multipliers (`data/price_table.csv`) | Sample values. Real ones come from licensed estimating databases |
| Car year and value, policy numbers, policyholders, accident descriptions, shops | Made up |

In production the price table is the insurer's licensed estimating database, the car and its value come from the policy record and a valuation service, and the shops are the insurer's network. The rules don't change; only the source of the numbers does.

## Evaluation

`scripts/run_eval.py` runs every sample claim through each model, with and without the accident description, and scores the result against the labels. Results are in `data/eval/summary.json` and on the Evaluation screen.

What it measures:

- **Damage reading:** which damaged parts the AI found (recall), how many of its findings were right (precision), and whether the damage type, severity and side match.
- **Dollar gap:** the AI's estimate against the estimate priced from the labels with the same price table. This shows what reading mistakes cost. It is not accuracy against real repair invoices, which needs an insurer's data.
- **Routing:** whether the claim gets the route it would get if the rules were fed the labels.
- **Uncertainty:** whether findings marked low confidence are wrong more often than those marked high.

What keeps it honest:

- The prompt was written using 12 photos that are not scored. Nothing was tuned on the scored photos.
- Labels can carry an accepted second answer (for example moderate or severe) and optional findings, because the photos are ambiguous in places.
- The sample is small: 24 claims and 36 photos. A few points of difference between models is noise.

### Labels

- **Human-checked (36 photos).** For 20 public photos an AI drafted the reading and a person confirmed or corrected each one; 9 of the 20 were corrected. For the 16 own photos a person described the damage first. The first method favours Claude somewhat.
- **AI-labelled (46 photos).** `scripts/ai_label.py` has four models from three providers (Claude, Gemini, OpenAI) label each photo, with extra input the app doesn't get (the dataset's damage outlines). A finding is kept when at least two of them agree. Nobody checked these labels. They are reported separately, next to a measurement of how well the same method reproduces the human-checked labels.

## Security of the demo

Everything sits behind one password, including the photos. Login attempts are limited per address. Live AI runs have a daily cap. Uploads must be real images under 12 MB; they are re-encoded, which removes location data. Model keys stay on the server. Search engines are told not to index the site.

## Left out on purpose

Claim intake, shop negotiation and final inspection (outside the brief). Video (next: sample frames and reuse the same flow). Policy and coverage checks. Real connections to a cost database or claims system. Fraud detection. User accounts and roles. Fine-tuning. Marking the damage on the photo.
