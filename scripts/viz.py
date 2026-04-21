"""Visualize navigation experiment results across three obstacle conditions."""

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.patches import Patch


CONDITIONS = [
    ("No Obstacle", Path("no_obstacle") / "raw_T2_bridge.csv"),
    ("Static Obstacle", Path("static_obstacle") / "raw_T3_bridge.csv"),
    ("Dynamic Obstacle", Path("dynamic_obstacle") / "raw_T4_bridge.csv"),
]

COLORS = ["#4C9AFF", "#F4A261", "#E76F51"]


def parse_args() -> argparse.Namespace:
    script_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=script_dir / "assets" / "output",
        help="Directory containing the per-condition subfolders (default: assets/output).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=script_dir / "assets" / "output" / "plots",
        help="Directory where plot PNGs are written.",
    )
    parser.add_argument(
        "--show",
        action="store_true",
        help="Display plots interactively in addition to saving them.",
    )
    return parser.parse_args()


def load_datasets(input_dir: Path) -> list[tuple[str, pd.DataFrame]]:
    datasets = []
    for label, rel_path in CONDITIONS:
        csv_path = input_dir / rel_path
        if not csv_path.exists():
            raise FileNotFoundError(f"Missing CSV for '{label}': {csv_path}")
        df = pd.read_csv(csv_path)
        df["nav_completed"] = df["nav_completed"].astype(str).str.strip().str.upper()
        df["result"] = df["result"].astype(str).str.strip().str.upper()
        datasets.append((label, df))
    return datasets


def stats(series: pd.Series) -> dict[str, float]:
    clean = series.dropna()
    return {
        "min": float(clean.min()),
        "max": float(clean.max()),
        "mean": float(clean.mean()),
        "std": float(clean.std(ddof=0)),
    }


def plot_error_distribution(
    datasets: list[tuple[str, pd.DataFrame]],
    column: str,
    title: str,
    ylabel: str,
    output_path: Path,
) -> None:
    labels = [label for label, _ in datasets]
    data = [df[column].dropna().values for _, df in datasets]
    per_condition_stats = [stats(df[column]) for _, df in datasets]
    means = [s["mean"] for s in per_condition_stats]
    stds = [s["std"] for s in per_condition_stats]

    fig, ax = plt.subplots(figsize=(10, 6))

    positions = np.arange(1, len(labels) + 1)
    box = ax.boxplot(
        data,
        positions=positions,
        widths=0.55,
        patch_artist=True,
        showmeans=True,
        meanline=False,
        meanprops=dict(marker="D", markerfacecolor="white", markeredgecolor="black", markersize=7),
        medianprops=dict(color="black", linewidth=1.5),
    )
    for patch, color in zip(box["boxes"], COLORS):
        patch.set_facecolor(color)
        patch.set_alpha(0.75)

    ax.errorbar(
        positions,
        means,
        yerr=stds,
        fmt="none",
        ecolor="black",
        elinewidth=1.3,
        capsize=8,
        capthick=1.3,
        label="Mean ± Std",
    )

    ax.set_xticks(positions)
    ax.set_xticklabels(labels)
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.grid(axis="y", linestyle="--", alpha=0.4)

    legend_handles = []
    for label, color, s in zip(labels, COLORS, per_condition_stats):
        legend_handles.append(
            Patch(
                facecolor=color,
                edgecolor="black",
                alpha=0.75,
                label=(
                    f"{label}\n"
                    f"min={s['min']:.3f}, max={s['max']:.3f}, "
                    f"mean={s['mean']:.3f}, std={s['std']:.3f}"
                ),
            )
        )
    ax.legend(handles=legend_handles, loc="upper left", bbox_to_anchor=(1.02, 1.0), fontsize=9, frameon=True)

    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    print(f"Saved: {output_path}")


def compute_wrr(df: pd.DataFrame) -> tuple[float, int, int]:
    total = len(df)
    if total == 0:
        return 0.0, 0, 0
    success_mask = (df["nav_completed"] == "YES") & (df["result"] == "PASS")
    successes = int(success_mask.sum())
    return successes / total, successes, total


def plot_wrr(
    datasets: list[tuple[str, pd.DataFrame]],
    output_path: Path,
) -> None:
    labels = [label for label, _ in datasets]
    results = [compute_wrr(df) for _, df in datasets]
    rates = [r[0] * 100 for r in results]

    fig, ax = plt.subplots(figsize=(9, 6))
    positions = np.arange(len(labels))
    bars = ax.bar(positions, rates, color=COLORS, edgecolor="black", alpha=0.85)

    for bar, (rate, successes, total) in zip(bars, results):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 1.0,
            f"{rate * 100:.1f}%\n({successes}/{total})",
            ha="center",
            va="bottom",
            fontsize=10,
        )

    ax.set_xticks(positions)
    ax.set_xticklabels(labels)
    ax.set_ylabel("Waypoint Reach Rate (%)")
    ax.set_title("Waypoint Reach Rate within 0.1 m")
    ax.set_ylim(0, 110)
    ax.grid(axis="y", linestyle="--", alpha=0.4)

    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    print(f"Saved: {output_path}")


def main() -> None:
    args = parse_args()
    datasets = load_datasets(args.input_dir)

    plot_error_distribution(
        datasets,
        column="distance_error_m",
        title="Distance Error Distribution by Condition",
        ylabel="Distance Error (m)",
        output_path=args.output_dir / "distance_error_distribution.png",
    )
    plot_error_distribution(
        datasets,
        column="heading_error_deg",
        title="Heading Error Distribution by Condition",
        ylabel="Heading Error (deg)",
        output_path=args.output_dir / "heading_error_distribution.png",
    )
    plot_wrr(datasets, output_path=args.output_dir / "waypoint_reach_rate.png")

    if args.show:
        plt.show()


if __name__ == "__main__":
    main()
