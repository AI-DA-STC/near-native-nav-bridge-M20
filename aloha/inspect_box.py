#!/usr/bin/env python3
"""Finds what is in the box in the Aloha's photos of its inside, with the Roboflow workflow "Carton Interior Mask
Preview" (carton_workflow.py): aloha/inspect_box.py <photo.jpg> [<photo.jpg> ...] [--out ...]

manipulator.py takes the photos, one per wrist camera, once the arms reach the last pose but one, and runs this on
them while the arms go home. The workflow finds the carton's interior in each photo, then the objects in it. Each
object is listed once, at its best confidence over the photos; the workflow's drawings of the photos (each object
boxed with its class and confidence) are put side by side in one image, a photo where it found no interior as taken.
Prints
  [INSPECT] Box contents: warning_taped_box 0.97, bottle 0.93; image <jpg with the objects outlined>
or "Box contents: nothing found; image ...". Before it, each photo where the workflow found no carton interior, so
looked for nothing, gives [INSPECT] No photo of the inside: ... Problems print [INSPECT] Cannot run: ...
Needs ROBOFLOW_API_KEY (exported, or in the package root's .env) and Pillow."""

import argparse
import sys
import time
from pathlib import Path

from carton_workflow import WorkflowError, run_carton_workflow

HERE = Path(__file__).resolve().parent


def say(text):
    print(f"[INSPECT] {text}", flush=True)


def side_by_side(images, path):
    """The images in one row, at the height of the tallest, saved as a JPEG"""
    from PIL import Image
    row = []
    for image in images:
        with Image.open(image) as opened:
            row.append(opened.convert("RGB"))
    height = max(image.height for image in row)
    row = [image if image.height == height else image.resize((round(image.width * height / image.height), height))
           for image in row]
    canvas = Image.new("RGB", (sum(image.width for image in row), height))
    x = 0
    for image in row:
        canvas.paste(image, (x, 0))
        x += image.width
    canvas.save(path, "JPEG", quality=90)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("photos", nargs="+", help="the photos, in the order they go side by side")
    parser.add_argument("--out", default=str(HERE.parent / "demo" / "detections"), help="where the images go")
    args = parser.parse_args()

    try:
        import PIL  # noqa: F401  (side_by_side)
    except ImportError as e:
        say(f"Cannot run: {e}. Install it with pip3 install Pillow")
        sys.exit(1)
    photos = [Path(photo) for photo in args.photos]
    unreadable = [str(photo) for photo in photos if not photo.is_file()]
    if unreadable:
        say(f"Cannot run: cannot read {', '.join(unreadable)}")
        sys.exit(1)
    out = Path(args.out)
    try:
        results = run_carton_workflow(photos, out)
    except WorkflowError as e:
        say(f"Cannot run: the Roboflow workflow: {e}")
        sys.exit(1)
    best, shown = {}, []
    for photo, result in zip(photos, results):
        if not result.interior:
            say(f"No photo of the inside: the workflow found no carton interior in {photo.name}")
        for name, p in result.objects:
            best[name] = max(best.get(name, 0.0), p)
        shown.append(result.image or photo)
    path = out / time.strftime("contents_%Y%m%d_%H%M%S.jpg")
    side_by_side(shown, path)
    found = sorted(best.items(), key=lambda item: -item[1])
    say(f"Box contents: {', '.join(f'{name} {p:.2f}' for name, p in found) or 'nothing found'}; image {path}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # said as a result, for the operator window
        say(f"Cannot run: {e}")
        sys.exit(1)
