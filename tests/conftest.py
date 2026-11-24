import os
import tempfile

# Tests never touch the real state folder or the real password.
os.environ["CLAIMS_STATE_DIR"] = tempfile.mkdtemp(prefix="claims-test-")
os.environ["DEMO_PASSWORD"] = "test-password"
os.environ["SESSION_SECRET"] = "test-secret"
os.environ["DAILY_LIVE_RUNS"] = "3"
