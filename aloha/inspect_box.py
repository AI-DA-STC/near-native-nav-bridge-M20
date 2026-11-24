#!/usr/bin/env python3
"""Finds the tools in the Aloha's photos of the box with the YOLO26 tools model,
external/lynx-M20-yolo/weights/tools_seg.pt: aloha/inspect_box.py <photo.jpg> [<photo.jpg> ...] [--out ...]

manipulator.py takes the photos, one per wrist camera, once the arms reach the last pose but one, and runs this on
them while the arms go home. Each object is listed once, at its best confidence over the photos; the photos are put
side by side, each object outlined, in one image. Prints
  [INSPECT] Box contents: drill 0.91, pliers 0.84; image <jpg with the objects outlined>
or "Box contents: nothing found; image ...". Problems print [INSPECT] Cannot run: ..."""

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = HERE.parent / "external" / "lynx-M20-yolo" / "weights" / "tools_seg.pt"
CONF = 0.25          # lowest confidence of an object reported


def say(text):
    print(f"[INSPECT] {text}", flush=True)


def side_by_side(images):
    """The images in one row, at the height of the tallest"""
    import cv2
    height = max(image.shape[0] for image in images)
    return cv2.hconcat([image if image.shape[0] == height
                        else cv2.resize(image, (round(image.shape[1] * height / image.shape[0]), height))
                        for image in images])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("photos", nargs="+", help="the photos, in the order they go side by side")
    parser.add_argument("--out", default=str(HERE.parent / "demo" / "detections"), help="where the image goes")
    args = parser.parse_args()

    try:
        import cv2
        import torch
        from ultralytics import YOLO
    except ImportError as e:
        say(f"Cannot run: {e}. Install it with pip3 install -r {HERE.parent / 'demo' / 'requirements-detect.txt'}")
        sys.exit(1)
    images = [cv2.imread(photo) for photo in args.photos]
    unreadable = [photo for photo, image in zip(args.photos, images) if image is None]
    if unreadable:
        say(f"Cannot run: cannot read {', '.join(unreadable)}")
        sys.exit(1)
    model = YOLO(str(MODEL))
    device = 0 if torch.cuda.is_available() else "cpu"
    best, plotted = {}, []
    for image in images:
        result = model.predict(image, conf=CONF, device=device, verbose=False)[0]
        for c, p in zip(result.boxes.cls, result.boxes.conf):
            name = result.names[int(c)]
            best[name] = max(best.get(name, 0.0), float(p))
        plotted.append(result.plot(line_width=2))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    path = out / time.strftime("contents_%Y%m%d_%H%M%S.jpg")
    cv2.imwrite(str(path), side_by_side(plotted), [cv2.IMWRITE_JPEG_QUALITY, 90])
    found = sorted(best.items(), key=lambda item: -item[1])
    say(f"Box contents: {', '.join(f'{name} {p:.2f}' for name, p in found) or 'nothing found'}; image {path}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # said as a result, for the operator window
        say(f"Cannot run: {e}")
        sys.exit(1)
