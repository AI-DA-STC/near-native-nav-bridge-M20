"""Save / load occupancy maps in the standard ROS map format (.pgm image + .yaml).

Same convention as nav2 map_server: 100 (occupied) -> black, 0 (free) -> white,
-1 (unknown) -> grey 205; loading applies occupied_thresh / free_thresh.
Used by `m20 map save <robot>` (from the robot's relayed SLAM map) and by the RViz
markers node, which publishes a site's saved map on /m20/map.
"""

import os

import yaml


def save(path_yaml, width, height, resolution, origin, data):
    """Write <name>.pgm + <name>.yaml. data: row-major occupancy, row 0 = bottom."""
    base = os.path.splitext(path_yaml)[0]
    pgm = base + '.pgm'
    rows = []
    for r in range(height - 1, -1, -1):        # image row 0 is the top
        row = data[r * width:(r + 1) * width]
        rows.append(bytes(0 if v >= 65 else 254 if 0 <= v <= 25 else 205 for v in row))
    with open(pgm, 'wb') as f:
        f.write(f'P5\n{width} {height}\n255\n'.encode())
        f.write(b''.join(rows))
    meta = {
        'image': os.path.basename(pgm),
        'mode': 'trinary',
        'resolution': float(resolution),
        'origin': [float(origin[0]), float(origin[1]), float(origin[2] if len(origin) > 2 else 0.0)],
        'negate': 0,
        'occupied_thresh': 0.65,
        'free_thresh': 0.196,       # grey 205 (unknown) = 0.196 stays unknown on load
    }
    with open(path_yaml, 'w') as f:
        yaml.safe_dump(meta, f, sort_keys=False)
    return pgm


def _read_pgm(path):
    with open(path, 'rb') as f:
        raw = f.read()
    tokens, i = [], 0
    while len(tokens) < 4:                     # magic, width, height, maxval (+ comments)
        while raw[i:i + 1].isspace():
            i += 1
        if raw[i:i + 1] == b'#':
            while raw[i:i + 1] not in (b'\n', b''):
                i += 1
            continue
        j = i
        while not raw[j:j + 1].isspace():
            j += 1
        tokens.append(raw[i:j])
        i = j
    if tokens[0] != b'P5':
        raise ValueError(f'{path}: only binary PGM (P5) is supported')
    w, h, maxval = int(tokens[1]), int(tokens[2]), int(tokens[3])
    return w, h, maxval, raw[i + 1:i + 1 + w * h]


def load(path_yaml):
    """-> dict(width, height, resolution, origin, data) with row 0 = bottom."""
    with open(path_yaml) as f:
        meta = yaml.safe_load(f)
    img = meta['image']
    if not os.path.isabs(img):
        img = os.path.join(os.path.dirname(os.path.abspath(path_yaml)), img)
    w, h, maxval, px = _read_pgm(img)
    occ_t, free_t = float(meta.get('occupied_thresh', 0.65)), float(meta.get('free_thresh', 0.196))
    negate = int(meta.get('negate', 0))
    data = []
    for r in range(h - 1, -1, -1):
        for v in px[r * w:(r + 1) * w]:
            p = (v if negate else maxval - v) / maxval
            data.append(100 if p > occ_t else 0 if p < free_t else -1)
    return {'width': w, 'height': h, 'resolution': float(meta['resolution']),
            'origin': meta.get('origin', [0.0, 0.0, 0.0]), 'data': data}
