"""Settings and paths. Secrets come from app/.env and never leave the server."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = APP_DIR / "data"
PHOTO_DIR = DATA_DIR / "photos"
STATE_DIR = Path(os.environ.get("CLAIMS_STATE_DIR", APP_DIR / "state"))
UPLOAD_DIR = STATE_DIR / "uploads"
DB_PATH = STATE_DIR / "claims.sqlite"
FRONTEND_DIST = APP_DIR / "frontend" / "dist"

load_dotenv(APP_DIR / ".env")

DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
DAILY_LIVE_RUNS = int(os.environ.get("DAILY_LIVE_RUNS", "60"))
SECURE_COOKIES = os.environ.get("SECURE_COOKIES", "0") == "1"

MAX_PHOTOS_PER_CLAIM = 6
MAX_UPLOAD_BYTES = 12 * 1024 * 1024
IMAGE_MAX_SIDE = 1568  # photos are resized to this before they go to a model

# Model the app uses for live assessments. Chosen from the eval; see README.
DEFAULT_MODEL = os.environ.get("ASSESS_MODEL", "claude-sonnet-5-5")

# Price per million tokens (input, output), used to show the model cost per claim
# and to cap spend. Claude prices are the published ones. The other two are
# estimates, marked as such wherever they are shown.
MODELS = {
    "claude-haiku-5-5": {"provider": "anthropic", "name": "Claude Haiku 5.5", "in": 0.10, "out": 0.50, "price_is_estimate": False},
    "claude-sonnet-5-5": {"provider": "anthropic", "name": "Claude Sonnet 5.5", "in": 2.00, "out": 10.00, "price_is_estimate": False},
    "claude-opus-5-5": {"provider": "anthropic", "name": "Claude Opus 5.5", "in": 4.00, "out": 20.00, "price_is_estimate": False},
    "gemini-3.1-pro-preview": {"provider": "gemini", "name": "Gemini 3.1 Pro (preview)", "in": 2.00, "out": 12.00, "price_is_estimate": True},
    "gemini-3.5-flash": {"provider": "gemini", "name": "Gemini 3.5 Flash", "in": 0.30, "out": 2.50, "price_is_estimate": True},
    "gpt-5": {"provider": "openai", "name": "OpenAI GPT-5", "in": 1.25, "out": 10.00, "price_is_estimate": True},
}
APP_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]

DEFAULT_SETTINGS = {
    "amount_threshold": 3000,        # estimates above this go to full review
    "total_loss_ratio": 0.75,        # estimate / car value at or above this flags a possible total loss
    "min_confidence_fast_track": "medium",  # findings below this go to full review
    "severe_to_full_review": True,   # any severe finding goes to full review
    "model": DEFAULT_MODEL,
}
