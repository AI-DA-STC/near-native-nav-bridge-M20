#!/usr/bin/env python3
"""Plots the search demo's saved waypoints, one panel per phase.
Usage (ROS sourced): python3 demo/viz_phases.py [--waypoints DIR] [--save FILE]"""

import argparse
import json
import math
import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE.parent / "scripts"))
from fleet_management import BOX_LENGTH_M, BOX_POSE, BOX_WIDTH_M, _quat_to_yaw  # noqa: E402

PHASES = [
    ("patrol", "1. Patrol (multi-waypoint-patrol)"),
    ("formation", "2. Formation (single-waypoint)"),
    ("sweep", "3. Sweep (multi-waypoint)"),
    ("cordon", "4. Cordon (single-waypoint)"),
]
COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
SURFACE, INK, MUTED, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
ARROW_M = 0.6


def box_corners():
    yaw = _quat_to_yaw(BOX_POSE.orientation)
    c, s = math.cos(yaw), math.sin(yaw)
    l, w = BOX_LENGTH_M / 2, BOX_WIDTH_M / 2
    pts = [(l, w), (-l, w), (-l, -w), (l, -w), (l, w)]
    return ([BOX_POSE.position.x + c * x - s * y for x, y in pts],
            [BOX_POSE.position.y + s * x + c * y for x, y in pts])


def draw_phase(ax, title, routes, colors, closed):
    ax.set_title(title, color=INK, loc="left", fontsize=11)
    bx, by = box_corners()
    ax.plot(bx, by, color=MUTED, lw=1.2)
    ax.annotate("box", (max(bx), max(by)), xytext=(3, 3), textcoords="offset points", color=MUTED, fontsize=8)
    if routes is None:
        ax.text(0.5, 0.5, "not recorded", transform=ax.transAxes, ha="center", color=MUTED)
        return
    for rid, wps in routes.items():
        color = colors[rid]
        xs, ys, yaws = [w["x"] for w in wps], [w["y"] for w in wps], [w["yaw"] for w in wps]
        if len(wps) > 1:
            ax.plot(xs + xs[:1] if closed else xs, ys + ys[:1] if closed else ys, color=color, lw=1.5, zorder=2)
        ax.quiver(xs, ys, [math.cos(a) for a in yaws], [math.sin(a) for a in yaws], color=color, angles="xy",
                  scale_units="xy", scale=1 / ARROW_M, width=0.005, zorder=3)
        ax.plot(xs, ys, "o", color=color, ms=5, mec=SURFACE, mew=1, zorder=4)
        ax.plot(xs[0], ys[0], "o", ms=9, mfc=SURFACE, mec=color, mew=2, zorder=5)
        ax.annotate(rid if len(wps) == 1 else f"{rid} start", (xs[0], ys[0]), xytext=(6, 6),
                    textcoords="offset points", color=INK, fontsize=8, zorder=6)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--waypoints", type=Path, default=HERE / "waypoints", help="directory of <phase>.json")
    parser.add_argument("--save", type=Path, help="write the figure to this file instead of showing it")
    args = parser.parse_args()

    phases = {}
    for phase, _ in PHASES:
        path = args.waypoints / f"{phase}.json"
        phases[phase] = json.loads(path.read_text()) if path.exists() else None
    robots = list(dict.fromkeys(rid for routes in phases.values() if routes for rid in routes))
    colors = dict(zip(robots, COLORS))
    points = [(w["x"], w["y"]) for routes in phases.values() if routes for wps in routes.values() for w in wps]
    points += list(zip(*box_corners()))
    xs, ys = [p[0] for p in points], [p[1] for p in points]

    fig, axes = plt.subplots(2, 2, figsize=(12, 10), facecolor=SURFACE)
    for ax, (phase, title) in zip(axes.flat, PHASES):
        ax.set_facecolor(SURFACE)
        draw_phase(ax, title, phases[phase], colors, closed=phase == "patrol")
        ax.set_xlim(min(xs) - 1, max(xs) + 1)
        ax.set_ylim(min(ys) - 1, max(ys) + 1)
        ax.set_aspect("equal", adjustable="box")
        ax.grid(color=GRID, lw=0.6)
        ax.tick_params(colors=MUTED, labelsize=8)
        for spine in ax.spines.values():
            spine.set_color(GRID)
        ax.set_xlabel("x (m, map)", color=MUTED, fontsize=9)
        ax.set_ylabel("y (m, map)", color=MUTED, fontsize=9)
    handles = [Line2D([], [], color=colors[rid], marker="o", lw=1.5, label=rid) for rid in robots]
    fig.legend(handles=handles, loc="upper right", ncol=max(len(handles), 1), frameon=False, labelcolor=INK)
    fig.suptitle("Search demo waypoints (large ring = WP1, arrow = heading)", color=INK, x=0.01, ha="left",
                 fontsize=12)
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    if args.save:
        fig.savefig(args.save, dpi=150, facecolor=SURFACE)
    else:
        plt.show()


if __name__ == "__main__":
    main()
