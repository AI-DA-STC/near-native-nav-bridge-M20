#!/usr/bin/env python3
"""Crops a map_server map to the part that was mapped, plus a margin: python3 crop_map.py <map.yaml> [margin_m]

Run on the ALOHA after saving a map. A saved map is 4000 x 4000 cells (16 MB) however little of it is known, and
map_server sends all of it over the Wi-Fi to aloha/bridge.sh, at every start of either: minutes on the ALOHA's link,
during which RViz and the Command center have no map. Cropped, it is a few hundred KB. The origin moves with the crop,
so every cell keeps its map coordinates: AMCL, move_base and recorded waypoints are unaffected. The first run keeps
the originals as <name>.pgm.orig and <name>.yaml.orig (copy them back to undo). Restart map_server afterwards (the
navigation window of start_aloha.sh: Ctrl+C, then Up and Enter)."""

import os
import shutil
import sys

import numpy as np
import yaml

UNKNOWN = 205  # map_saver's value for unknown cells


def read_pgm(path):
    with open(path, "rb") as f:
        if f.readline().strip() != b"P5":
            sys.exit(f"{path} is not a binary PGM (P5)")
        line = f.readline()
        while line.startswith(b"#"):
            line = f.readline()
        width, height = map(int, line.split())
        maxval = int(f.readline())
        return np.frombuffer(f.read(), dtype=np.uint8).reshape(height, width), maxval


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    path = sys.argv[1]
    margin_m = float(sys.argv[2]) if len(sys.argv) == 3 else 2.0
    with open(path) as f:
        text = f.read()
    meta = yaml.safe_load(text)
    pgm = os.path.join(os.path.dirname(os.path.abspath(path)), meta["image"])
    img, maxval = read_pgm(pgm)
    height, width = img.shape
    known = np.argwhere(img != UNKNOWN)
    if not len(known):
        sys.exit(f"{pgm} has no known cells")
    (r0, c0), (r1, c1) = known.min(0), known.max(0)
    m = int(round(margin_m / meta["resolution"]))
    r0, c0, r1, c1 = max(0, r0 - m), max(0, c0 - m), min(height - 1, r1 + m), min(width - 1, c1 + m)
    crop = img[r0:r1 + 1, c0:c1 + 1]
    if crop.shape == img.shape:
        print(f"{pgm}: nothing to crop ({width} x {height})")
        return
    res = float(meta["resolution"])
    ox, oy, oyaw = (float(v) for v in meta["origin"])
    # The image's row 0 is the map's top: the crop's last row, r1, becomes the grid's row 0
    origin = [round(ox + c0 * res, 6), round(oy + (height - 1 - r1) * res, 6), oyaw]

    # A cell keeps its map coordinates
    r, c = known[len(known) // 2]
    before = (ox + (c + 0.5) * res, oy + (height - 1 - r + 0.5) * res)
    after = (origin[0] + (c - c0 + 0.5) * res, origin[1] + (crop.shape[0] - 1 - (r - r0) + 0.5) * res)
    assert np.allclose(before, after, atol=1e-6) and crop[r - r0, c - c0] == img[r, c]

    for original in (pgm, path):
        if not os.path.exists(original + ".orig"):
            shutil.copy2(original, original + ".orig")
    with open(pgm + ".tmp", "wb") as f:
        f.write(b"P5\n# cropped from %d x %d by crop_map.py\n%d %d\n%d\n" % (width, height, crop.shape[1], crop.shape[0], maxval))
        f.write(crop.tobytes())
    lines = [f"origin: [{origin[0]}, {origin[1]}, {origin[2]}]" if line.startswith("origin:") else line
             for line in text.splitlines()]
    with open(path + ".tmp", "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(pgm + ".tmp", pgm)
    os.replace(path + ".tmp", path)
    print(f"{pgm}: {width} x {height} -> {crop.shape[1]} x {crop.shape[0]} cells ({os.path.getsize(pgm)} bytes), "
          f"origin {ox}, {oy} -> {origin[0]}, {origin[1]}. Originals: {os.path.basename(pgm)}.orig, "
          f"{os.path.basename(path)}.orig")


if __name__ == "__main__":
    main()
