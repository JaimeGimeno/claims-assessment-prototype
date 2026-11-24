"""Covers licence plates and bystanders' faces in the public dataset photos.

The photos come from a public set, but the repo shouldn't republish other people's plates.
Boxes were found by eye. A 4-number entry is a rectangle, a longer one is a polygon of corner points.
Run after scripts/build_data.py, which copies the photos fresh: python scripts/cover_plates.py
The stored AI results in data/precomputed and data/eval were computed before the plates were covered.
"""
from pathlib import Path

from PIL import Image, ImageDraw

PHOTOS = Path(__file__).resolve().parent.parent / "data" / "photos" / "kaggle"
FILL = (38, 38, 40)

COVERS = {
    "test-28": [(795, 672, 900, 785), (0, 198, 18, 236)],
    "train-13": [(255, 728, 306, 692, 436, 938, 430, 1024, 356, 1024)],
    "train-14": [(0, 650, 170, 870)],
    "train-23": [(30, 748, 72, 728, 206, 918, 198, 1012, 150, 1012, 38, 836)],
    "train-29": [(0, 645, 95, 805)],
    "train-47": [(365, 700, 715, 815)],
    "train-51": [(186, 532, 216, 508, 322, 672, 318, 736, 280, 728, 190, 578), (965, 128, 1024, 162), (368, 46, 416, 76)],
    "train-54": [(900, 858, 985, 945)],
    "train-56": [(0, 38, 28, 85), (299, 69, 341, 123)],
    "train-63": [(342, 486, 528, 622)],
    "train-64": [(776, 0, 915, 84)],
    "train-69": [(188, 668, 384, 776)],
    "train-70": [(405, 285, 472, 382), (600, 148, 660, 220)],
    "train-75": [(80, 582, 112, 570, 184, 672, 178, 744, 146, 740, 84, 634)],
    "train-80": [(950, 290, 1024, 322)],
    "val-3": [(0, 238, 104, 384)],
    "val-24": [(86, 705, 232, 822)],
    "val-32": [(300, 262, 582, 352)],
    "val-42": [(0, 680, 30, 755)],
}


def main() -> None:
    for name, shapes in COVERS.items():
        path = PHOTOS / f"{name}.jpg"
        im = Image.open(path).convert("RGB")
        d = ImageDraw.Draw(im)
        for s in shapes:
            if len(s) == 4:
                d.rounded_rectangle(s, radius=6, fill=FILL)
            else:
                d.polygon(list(zip(s[0::2], s[1::2])), fill=FILL)
        im.save(path, quality=90)
    print(f"covered {len(COVERS)} photos")


if __name__ == "__main__":
    main()
