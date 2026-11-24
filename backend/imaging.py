"""Photo handling: safe decoding, resizing, and a cheap quality gate with no AI."""
from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageOps

from .config import IMAGE_MAX_SIDE

try:  # iPhone photos
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception:  # pragma: no cover
    pillow_heif = None

ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP", "HEIF", "HEIC", "MPO"}

# Thresholds for the computed gate. Deliberately loose: it only rejects photos that
# are clearly unusable. The model judges the rest (too far, wrong angle, not a car).
MIN_SIDE = 320
MIN_SHARPNESS = 12.0
MIN_BRIGHTNESS = 22.0
MAX_BRIGHTNESS = 245.0


class BadImage(ValueError):
    pass


def load_image(data: bytes) -> Image.Image:
    """Decodes untrusted bytes. Raises BadImage for anything that isn't a photo."""
    try:
        probe = Image.open(io.BytesIO(data))
        fmt = (probe.format or "").upper()
        probe.verify()
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:
        raise BadImage("This file isn't a readable image.") from e
    if fmt not in ALLOWED_FORMATS:
        raise BadImage(f"Unsupported image type: {fmt or 'unknown'}.")
    if img.width * img.height > 60_000_000:
        raise BadImage("The image is too large.")
    img = ImageOps.exif_transpose(img)  # apply the phone's rotation
    return img.convert("RGB")


def to_jpeg(img: Image.Image, max_side: int = IMAGE_MAX_SIDE, quality: int = 88) -> bytes:
    """Re-encodes as JPEG at a bounded size. This also drops all metadata (location)."""
    img = img.copy()
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def quality_gate(img: Image.Image) -> dict:
    """Resolution, sharpness and brightness, computed without a model."""
    small = img.copy()
    small.thumbnail((640, 640))
    g = np.asarray(small.convert("L"), dtype=np.float32)
    # variance of a Laplacian: low means few sharp edges, so a blurred photo
    lap = (-4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:])
    sharpness = float(lap.var())
    brightness = float(g.mean())
    issue = ""
    if min(img.size) < MIN_SIDE:
        issue = "too_small"
    elif brightness < MIN_BRIGHTNESS:
        issue = "too_dark"
    elif brightness > MAX_BRIGHTNESS:
        issue = "overexposed"
    elif sharpness < MIN_SHARPNESS:
        issue = "blurry"
    return {"ok": not issue, "issue": issue, "sharpness": round(sharpness, 1), "brightness": round(brightness, 1),
            "width": img.width, "height": img.height}
