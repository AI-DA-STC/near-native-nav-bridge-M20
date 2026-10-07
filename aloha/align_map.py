#!/usr/bin/env python3
"""Redraw an Aloha gmapping map in the DeepRobotics map frame: align_map.py <aloha.yaml> <occ_grid.yaml>"""
import argparse
import math
import os

import numpy as np
import yaml
from PIL import Image


def load_map(path):
    meta = yaml.safe_load(open(path))
    base = os.path.dirname(os.path.abspath(path))
    img_path = os.path.join(base, meta['image'])
    if not os.path.exists(img_path):
        img_path = os.path.join(base, os.path.basename(meta['image']))
    img = np.flipud(np.array(Image.open(img_path).convert('L')))
    p = (img if meta.get('negate', 0) else 255 - img) / 255.0
    occ = p > meta['occupied_thresh']
    return dict(meta=meta, img=img, occ=occ, known=occ | (p < meta['free_thresh']), res=meta['resolution'], origin=np.array(meta['origin'][:2], float))


def crop_known(m, margin=10):
    i, j = np.nonzero(m['known'])
    i0, j0 = max(i.min() - margin, 0), max(j.min() - margin, 0)
    i1, j1 = i.max() + margin + 1, j.max() + margin + 1
    return dict(m, img=m['img'][i0:i1, j0:j1], occ=m['occ'][i0:i1, j0:j1], known=m['known'][i0:i1, j0:j1],
                origin=m['origin'] + np.array([j0, i0]) * m['res'])


def occupied_points(m):
    i, j = np.nonzero(m['occ'])
    return m['origin'] + (np.stack([j, i], 1) + 0.5) * m['res']


def rot(theta):
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s], [s, c]])


def score_field(ref, sigma=0.15):
    occ, res = ref['occ'], ref['res']
    r = int(math.ceil(3 * sigma / res))
    pad = np.pad(occ, r).astype(float)
    field = np.zeros(occ.shape)
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            w = math.exp(-(di * di + dj * dj) * res * res / (2 * sigma * sigma))
            field = np.maximum(field, w * pad[r + di:r + di + occ.shape[0], r + dj:r + dj + occ.shape[1]])
    return field


def global_search(ref, pts, step_deg=1.0):
    field = score_field(ref)
    h, w = field.shape
    res = ref['res']
    results = []
    for deg in np.arange(0.0, 360.0, step_deg):
        q = pts @ rot(math.radians(deg)).T
        cells = np.floor(q / res).astype(int)
        cmin = cells.min(0)
        cells -= cmin
        a = np.zeros((cells[:, 1].max() + 1, cells[:, 0].max() + 1))
        a[cells[:, 1], cells[:, 0]] = 1.0
        shape = (h + a.shape[0], w + a.shape[1])
        corr = np.fft.irfft2(np.fft.rfft2(field, shape) * np.conj(np.fft.rfft2(a, shape)), shape)
        k, l = np.unravel_index(corr.argmax(), shape)
        k = k - shape[0] if k >= h else k
        l = l - shape[1] if l >= w else l
        t = ref['origin'] + (np.array([l, k]) - cmin) * res
        results.append((corr.max() / a.sum(), deg, t))
    return sorted(results, key=lambda r: -r[0])


def nearest(q, dst):
    d = np.empty(len(q))
    idx = np.empty(len(q), int)
    for k in range(0, len(q), 1000):
        dd = ((q[k:k + 1000, None, :] - dst[None]) ** 2).sum(-1)
        idx[k:k + 1000] = dd.argmin(1)
        d[k:k + 1000] = np.sqrt(dd.min(1))
    return d, idx


def icp(src, dst, R, t, iters=40, max_dist=0.3):
    for _ in range(iters):
        q = src @ R.T + t
        d, idx = nearest(q, dst)
        keep = d < max_dist
        a, b = q[keep], dst[idx[keep]]
        ma, mb = a.mean(0), b.mean(0)
        u, _, vt = np.linalg.svd((a - ma).T @ (b - mb))
        dr = vt.T @ np.diag([1.0, np.linalg.det(vt.T @ u.T)]) @ u.T
        R, t = dr @ R, dr @ (t - ma) + mb
    return R, t


def redraw(aloha, R, t):
    res, img = aloha['res'], aloha['img']
    h, w = img.shape
    corners = aloha['origin'] + np.array([[0, 0], [w, 0], [0, h], [w, h]]) * res
    cw = corners @ R.T + t
    lo = np.floor(cw.min(0) / res) * res
    nw, nh = np.ceil((cw.max(0) - lo) / res).astype(int)
    jj, ii = np.meshgrid(np.arange(nw), np.arange(nh))
    q = np.stack([lo[0] + (jj + 0.5) * res, lo[1] + (ii + 0.5) * res], -1)
    p = (q - t) @ R
    sj, si = np.floor((p - aloha['origin']) / res).astype(int).transpose(2, 0, 1)
    ok = (si >= 0) & (si < h) & (sj >= 0) & (sj < w)
    out = np.full((nh, nw), 205, np.uint8)
    out[ok] = img[si[ok], sj[ok]]
    i, j = np.nonzero(out != 205)
    i0, j0 = max(i.min() - 10, 0), max(j.min() - 10, 0)
    return out[i0:i.max() + 11, j0:j.max() + 11], lo + np.array([j0, i0]) * res


def overlay(ref, out, lo, res, path):
    rh, rw = ref['occ'].shape
    hi = np.maximum(lo + np.array(out.shape[::-1]) * res, ref['origin'] + np.array([rw, rh]) * ref['res'])
    lo2 = np.minimum(lo, ref['origin'])
    nw, nh = np.ceil((hi - lo2) / res).astype(int)
    jj, ii = np.meshgrid(np.arange(nw), np.arange(nh))
    q = np.stack([lo2[0] + (jj + 0.5) * res, lo2[1] + (ii + 0.5) * res], -1)
    hits = []
    for occ, origin, r in ((ref['occ'], ref['origin'], ref['res']), (out < 128, lo, res)):
        j, i = np.floor((q - origin) / r).astype(int).transpose(2, 0, 1)
        ok = (i >= 0) & (i < occ.shape[0]) & (j >= 0) & (j < occ.shape[1])
        hit = np.zeros(ok.shape, bool)
        hit[ok] = occ[i[ok], j[ok]]
        hits.append(hit)
    canvas = np.full((nh, nw, 3), 255, np.uint8)
    canvas[hits[0]] = (60, 110, 255)
    canvas[hits[1]] = (230, 0, 0)
    canvas[hits[0] & hits[1]] = (0, 0, 0)
    Image.fromarray(np.flipud(canvas)).save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('aloha_yaml')
    ap.add_argument('deeprobotics_yaml')
    ap.add_argument('-o', '--out', help='output prefix (default: <aloha_yaml>_aligned)')
    args = ap.parse_args()
    out_prefix = args.out or os.path.splitext(args.aloha_yaml)[0] + '_aligned'

    aloha, ref = crop_known(load_map(args.aloha_yaml)), load_map(args.deeprobotics_yaml)
    src_all, dst = occupied_points(aloha), occupied_points(ref)
    rng = np.random.default_rng(0)
    src = src_all[rng.choice(len(src_all), min(4000, len(src_all)), replace=False)]

    results = global_search(ref, src)
    best_score, best_deg, best_t = results[0]
    runner_up = next(r for r in results if abs((r[1] - best_deg + 180) % 360 - 180) > 10)
    R, t = icp(src, dst, rot(math.radians(best_deg)), best_t)
    d, _ = nearest(src @ R.T + t, dst)

    out, lo = redraw(aloha, R, t)
    Image.fromarray(np.flipud(out)).save(out_prefix + '.pgm')
    meta = dict(aloha['meta'], image=os.path.basename(out_prefix) + '.pgm', origin=[round(float(lo[0]), 4), round(float(lo[1]), 4), 0.0])
    with open(out_prefix + '.yaml', 'w') as f:
        yaml.safe_dump(meta, f, default_flow_style=None, sort_keys=False)
    overlay(ref, out, lo, aloha['res'], out_prefix + '_overlay.png')

    yaw = math.degrees(math.atan2(R[1, 0], R[0, 0]))
    print('aloha map -> deeprobotics map: x %.3f m, y %.3f m, yaw %.2f deg' % (t[0], t[1], yaw))
    print('fit: %.0f%% of aloha walls within 0.10 m of a deeprobotics wall, %.0f%% within 0.20 m' % (100 * (d < 0.1).mean(), 100 * (d < 0.2).mean()))
    print('next-best heading (%.0f deg) scores %.0f%% of the best%s' % (runner_up[1], 100 * runner_up[0] / best_score, '  <-- ambiguous, check the overlay' if runner_up[0] > 0.9 * best_score else ''))
    print('wrote %s.pgm, %s.yaml, %s_overlay.png (black: both maps, blue: deeprobotics only, red: aloha only)' % (out_prefix, out_prefix, out_prefix))


if __name__ == '__main__':
    main()
