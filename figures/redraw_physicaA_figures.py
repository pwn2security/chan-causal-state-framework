"""Unified Physica A publication-grade figure renderer (9-figure suite: Figures 2-9).

Option A merged layout:
- Figure 1: Conceptual primer (PPTX baseline copied unchanged)
- Figure 2: Full 720-bar BTCUSDT sealed hierarchy (single panel, zoom box -> Fig. 4)
- Figure 3: Full 571-bar BTCUSDT negative-case window (symmetric companion to Fig. 2)
- Figure 4: MERGED centerpiece — (a) Initial Pivot [ZD, ZG] + [DD, GG] + apex inset (bars 44-85)
            + three-clock markers (180/248/254); (b) shared-x four-clock causal-availability
            latency lanes for S1, S2, S3, Z1
- Figure 5: Four fixed July 2026 cross-underlying windows (BTCUSDT, ETHUSDT, XAUUSDT, SPYUSDT)
- Figure 6: Native confirmation-clock offsets across 12 windows (with individual Pivot dots)
- Figure 7: Computational scaling on logarithmic axes (120-10,000 bars, 600 s censoring)
- Figure 8: 14-window cross-implementation correspondence heatmap (K, F, B, S*)
- Figure 9: Internal vs External projections on the 571-bar BTCUSDT window

Strict scientific integrity rules:
- Artifact-only rendering: NEVER imports or invokes any parser, replay engine, or matcher.
- Reads exclusively from frozen, SHA-256-verified JSON/CSV artifacts.
- Asserts all frozen inputs are byte-identical before and after rendering.
- Outputs 100% vector PDFs with TrueType embedded fonts (pdf.fonttype = 42, zero Type 3,
  zero embedded raster images) plus 300-DPI PNG previews.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

OUT_ROOT = Path(r"./physicaA\figures")
PREVIEWS = OUT_ROOT / "previews"
MPL_CACHE = OUT_ROOT.parent / "scripts" / "mpl-cache"
MPL_CACHE.mkdir(parents=True, exist_ok=True)
os.environ["MPLCONFIGDIR"] = str(MPL_CACHE)

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.cm import ScalarMappable
from matplotlib.collections import LineCollection
from matplotlib.colors import LinearSegmentedColormap, Normalize
from matplotlib.lines import Line2D
from matplotlib.patches import ConnectionPatch, Patch, Rectangle
from matplotlib.ticker import FixedLocator, FuncFormatter, NullLocator, ScalarFormatter

# ---------------------------------------------------------------------------
# Frozen input paths (strictly read-only)
# ---------------------------------------------------------------------------
WB = Path(r"./local_archive")
RV = WB / "research_validation_v2"
E4 = WB / "player/experiments/core-paper/formal-results/FORMAL-E4-R1-20260916T125904Z/e4-reconstruction/figure-data"
R4 = RV / "formal-results-r4-cross-underlying"
H_REF = WB / "review_v12_extensions/manuscript-figure-refinement"
R7_DATA = Path(r"./external_r7\formal-run\R7-FORMAL-14-20261009T095213Z\figures\source-data\R7-C.json")
FOUR_CLOCK = Path(r"./four_clock_replay\sz_four_clock_table.json")
FIG1_SRC = Path(r"./figures/Figure1.pdf")
EXP2_ABLATION = Path(r"./physicaA\experiments\results\exp2_hashing_ablation.json")

INPUTS = {
    "fig2": E4 / "full-BTCUSDT-2025-01-02-1s-derived-720.json",
    "fig3": E4 / "full-BTCUSDT-2025-01-01-tick-derived-571.json",
    "fig4": E4 / "real-pivot-establishment.json",
    "four_clock": FOUR_CLOCK,
    "r4_protocol": R4 / "R4_EXPERIMENT_PROTOCOL.json",
    "fig6_delay": H_REF / "STEP03L-FIGURE7-v1.4/verified-data/figure7-data.json",
    "fig7_scaling_result": RV / "formal-results-r2/json/E5-X-R2-20260922T005351Z-result.json",
    "fig7_scaling_protocol": RV / "config/reviewer_critical_experiments_protocol.json",
    "fig8_heatmap": H_REF / "STEP03N-FIGURE9-v1.0/verified-data/figure9-data.json",
    "fig9_r7c": R7_DATA,
}

# ---------------------------------------------------------------------------
# Unified Physica A Okabe-Ito colorblind-safe visual grammar
# ---------------------------------------------------------------------------
PAL = {
    "raw_wick": "#4D4D4D",
    "raw_up": "#FFFFFF",
    "raw_down": "#7A7A7A",
    "k": "#009E73",         # teal: Normalized K
    "f_top": "#E69F00",     # amber: Fractal TOP (always '^')
    "f_bot": "#56B4E9",     # sky blue: Fractal BOTTOM (always 'v')
    "stroke": "#0072B2",    # steel blue: Stroke (B)
    "segment": "#D55E00",   # vermilion: Segment (S)
    "pivot": "#CC79A7",     # mauve: Pivot [ZD, ZG]
    "ddgg": "#7A7A7A",      # neutral gray: Pivot span [DD, GG]
    "event": "#1A1A1A",     # near-black: t_event
    "native": "#0072B2",    # steel blue: t_native
    "guard": "#A61C3C",     # deep crimson: t_guard = t_emit
    "axis": "#333333",
    "grid": "#E6EAEE",
    "text": "#1F2933",
    "muted": "#52606D",
    "stat_seg": "#2B5C8F",
    "stat_piv": "#D07A2D",
    "completed": "#2B5C8F",
    "watchdog": "#A61C3C",
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def apply_master_style() -> None:
    plt.rcdefaults()
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["DejaVu Sans"],
        "mathtext.fontset": "dejavusans",
        "font.size": 9.0,
        "axes.titlesize": 10.0,
        "axes.labelsize": 9.5,
        "xtick.labelsize": 8.5,
        "ytick.labelsize": 8.5,
        "legend.fontsize": 8.0,
        "axes.linewidth": 0.7,
        "axes.edgecolor": PAL["axis"],
        "axes.labelcolor": PAL["text"],
        "xtick.color": PAL["axis"],
        "ytick.color": PAL["axis"],
        "text.color": PAL["text"],
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "savefig.facecolor": "white",
        "savefig.edgecolor": "white",
        "axes.formatter.useoffset": False,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    })


def style_axes(ax, *, grid_axis: str = "both") -> None:
    ax.set_axisbelow(True)
    ax.grid(True, axis=grid_axis, which="major", color=PAL["grid"], lw=0.48, zorder=0)
    for sp in ax.spines.values():
        sp.set_color(PAL["axis"])
        sp.set_linewidth(0.7)
    ax.tick_params(length=3.2, width=0.65, pad=3.0)
    sf = ScalarFormatter(useOffset=False)
    sf.set_scientific(False)
    ax.yaxis.set_major_formatter(sf)


def save_fig(fig, name: str, *, title: str, tight: bool = True, pad: float = 0.06) -> dict:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    pdf = OUT_ROOT / f"{name}.pdf"
    png = PREVIEWS / f"{name}.png"
    save_kw = dict(metadata={"Title": title, "CreationDate": None, "ModDate": None})
    if tight:
        fig.savefig(pdf, format="pdf", bbox_inches="tight", pad_inches=pad, **save_kw)
        fig.savefig(png, format="png", dpi=300, bbox_inches="tight", pad_inches=pad)
    else:
        fig.savefig(pdf, format="pdf", **save_kw)
        fig.savefig(png, format="png", dpi=300)
    plt.close(fig)
    raw = pdf.read_bytes()
    has_type3 = b"/Subtype /Type3" in raw or b"/Subtype/Type3" in raw
    has_image = b"/Subtype /Image" in raw or b"/Subtype/Image" in raw
    if has_type3:
        raise RuntimeError(f"TYPE3_FONT_DETECTED in {pdf}")
    if has_image:
        raise RuntimeError(f"RASTER_IMAGE_DETECTED in {pdf}")
    return {
        "figure": name,
        "pdf": str(pdf),
        "png": str(png),
        "pdfSha256": sha256(pdf),
        "type3Font": has_type3,
        "rasterImage": has_image,
        "bytes": len(raw),
    }


# ---------------------------------------------------------------------------
# Shared structural-layer drawing primitives (exact frozen coordinates)
# ---------------------------------------------------------------------------
def draw_price_bars(ax, bars: list[dict], *, lw_wick: float = 0.35, lw_body: float = 1.15) -> None:
    xs = [float(b["index"]) for b in bars]
    hi = [float(b["high"]) for b in bars]
    lo = [float(b["low"]) for b in bars]
    op = [float(b["open"]) for b in bars]
    cl = [float(b["close"]) for b in bars]
    ax.vlines(xs, lo, hi, colors=PAL["raw_wick"], linewidths=lw_wick, zorder=2.0)
    body = LineCollection(
        [[(x, o), (x, c)] for x, o, c in zip(xs, op, cl)],
        colors=[PAL["raw_down"] if c < o else PAL["raw_wick"] for o, c in zip(op, cl)],
        linewidths=lw_body,
        zorder=2.2,
    )
    ax.add_collection(body)


def draw_norm_k(ax, items: list[dict], *, lw: float = 0.42, alpha: float = 0.55) -> None:
    for item in items:
        g = item["geometry"]
        a, b = float(g["sourceStartRawBarIndex"]), float(g["sourceEndRawBarIndex"])
        lo, hi = float(g["low"]), float(g["high"])
        ax.add_patch(Rectangle(
            (a - 0.35, lo), max(0.6, b - a + 0.7), hi - lo,
            fill=False, linewidth=lw, edgecolor=PAL["k"], alpha=alpha, zorder=3.0,
        ))


def draw_strokes(ax, items: list[dict], *, lw: float = 0.7, dashed: bool = True) -> None:
    segs = []
    for item in items:
        g = item["geometry"]
        segs.append([(float(g["startRawBarIndex"]), float(g["startPrice"])),
                     (float(g["endRawBarIndex"]), float(g["endPrice"]))])
    if segs:
        ls = (0, (2.6, 1.4)) if dashed else "-"
        ax.add_collection(LineCollection(segs, colors=PAL["stroke"], linewidths=lw, linestyles=ls, zorder=4.0))


def draw_fractals(ax, items: list[dict], *, size: float = 14.0, edge: str = "white", edge_lw: float = 0.25) -> None:
    tops = [(float(f["eventRawBarIndex"]), float(f["geometry"]["price"]))
            for f in items if f["geometry"]["type"] == "TOP"]
    bots = [(float(f["eventRawBarIndex"]), float(f["geometry"]["price"]))
            for f in items if f["geometry"]["type"] == "BOTTOM"]
    if tops:
        ax.scatter(*zip(*tops), marker="^", s=size, c=PAL["f_top"],
                   edgecolors=edge, linewidths=edge_lw, zorder=6.0)
    if bots:
        ax.scatter(*zip(*bots), marker="v", s=size, c=PAL["f_bot"],
                   edgecolors=edge, linewidths=edge_lw, zorder=6.0)


def draw_pivot_box(ax, pivot: dict, *, show_ddgg: bool = False) -> None:
    g = pivot["geometry"]
    x0, x1 = float(g["startRawBarIndex"]), float(g["endRawBarIndex"])
    zd, zg = float(g["ZD"]), float(g["ZG"])
    ax.add_patch(Rectangle((x0, zd), x1 - x0, zg - zd,
                           facecolor=PAL["pivot"], edgecolor="none", alpha=0.11, zorder=1.0))
    ax.add_patch(Rectangle((x0, zd), x1 - x0, zg - zd,
                           facecolor="none", edgecolor=PAL["pivot"], linewidth=0.6,
                           alpha=0.26, hatch="//", zorder=1.1))
    ax.hlines([zd, zg], x0, x1, colors=PAL["pivot"], linewidths=1.0, zorder=1.3)
    if show_ddgg and "DD" in g and "GG" in g:
        ax.hlines([float(g["DD"]), float(g["GG"])], x0, x1,
                  colors=PAL["ddgg"], linewidths=0.65, linestyles=(0, (1.5, 1.5)), zorder=1.2)


def draw_segments(ax, items: list[dict], *, lw: float = 2.0) -> None:
    for item in items:
        g = item["geometry"]
        ax.plot([float(g["startRawBarIndex"]), float(g["endRawBarIndex"])],
                [float(g["startPrice"]), float(g["endPrice"])],
                color=PAL["segment"], lw=lw, solid_capstyle="round", zorder=5.0)


def load_720_four_clocks() -> dict:
    fc = json.loads(INPUTS["four_clock"].read_text("utf-8"))
    rows = [r for r in fc if r.get("window_id") == "BTCUSDT-2025-01-02-1s-derived-720"]
    segs = sorted([r for r in rows if r["type"] == "C1"], key=lambda x: x["k_event"])
    pivs = [r for r in rows if r["type"] == "Z"]
    assert len(segs) == 3 and len(pivs) == 1
    assert [(s["k_event"], s["k_native"], s["k_guard_eligible"], s["k_emit_first"]) for s in segs] == [
        (68, 139, 143, 143),
        (93, 149, 154, 154),
        (180, 248, 254, 254),
    ]
    z = pivs[0]
    assert (z["k_event"], z["k_native"], z["k_guard_eligible"], z["k_emit_first"]) == (180, 248, 254, 254)
    return {"segments": segs, "pivot": z}


# ---------------------------------------------------------------------------
# Figure 2: Clean single-panel 720-bar positive hierarchy
# ---------------------------------------------------------------------------
def build_figure2() -> dict:
    apply_master_style()
    data = json.loads(INPUTS["fig2"].read_text("utf-8"))
    st = data["structures"]
    bars = data["bars"]
    assert (len(bars), len(st["normalizedK"]), len(st["fractals"]),
            len(st["strokes"]), len(st["segments"]), len(st["pivots"])) == (720, 511, 223, 87, 3, 1)

    fig, ax = plt.subplots(figsize=(9.0, 3.85))
    draw_pivot_box(ax, st["pivots"][0], show_ddgg=False)
    draw_price_bars(ax, bars, lw_wick=0.30, lw_body=0.95)
    draw_norm_k(ax, st["normalizedK"], lw=0.36, alpha=0.52)
    draw_strokes(ax, st["strokes"], lw=0.60, dashed=True)
    draw_segments(ax, st["segments"], lw=2.0)
    draw_fractals(ax, st["fractals"], size=11.0, edge="none", edge_lw=0.0)

    zoom_box = Rectangle((-2, 94340), 278, 1320, fill=False,
                         edgecolor="#52606D", linewidth=0.85, linestyle=(0, (4, 2.5)), zorder=7)
    ax.add_patch(zoom_box)
    ax.text(274, 95700, "Enlarged in Fig. 4 (bars 0–276)", ha="right", va="bottom",
            fontsize=7.8, color="#52606D", style="italic", zorder=8)

    ax.set_xlim(-8, 728)
    ax.set_ylim(94250, 97020)
    ax.set_xlabel("Raw closed-bar index")
    ax.set_ylabel("Price (USDT)")
    style_axes(ax)

    handles = [
        Line2D([], [], color=PAL["raw_wick"], lw=1.1, label="Price (raw OHLC)"),
        Line2D([], [], color=PAL["k"], lw=1.0, label="Normalized K"),
        Line2D([], [], marker="^", ls="none", color=PAL["f_top"], markersize=5.2, label="Fractal TOP"),
        Line2D([], [], marker="v", ls="none", color=PAL["f_bot"], markersize=5.2, label="Fractal BOTTOM"),
        Line2D([], [], color=PAL["stroke"], lw=1.0, ls=(0, (2.6, 1.4)), label="Stroke"),
        Line2D([], [], color=PAL["segment"], lw=2.0, label="Segment"),
        Patch(facecolor=PAL["pivot"], edgecolor=PAL["pivot"], alpha=0.25, hatch="//", label="Pivot [ZD, ZG]"),
    ]
    leg = ax.legend(handles=handles, loc="upper left", bbox_to_anchor=(0.012, 0.985),
                    ncol=2, frameon=True, fancybox=False, facecolor="white",
                    edgecolor="#C8D0D8", framealpha=0.94, fontsize=7.6,
                    borderpad=0.38, labelspacing=0.25, handlelength=1.75, columnspacing=0.9)
    leg.get_frame().set_linewidth(0.65)
    leg.set_zorder(20)

    ax.text(0.988, 0.045, "BTCUSDT (720 bars):  K = 511,  F = 223,  B = 87,  S = 3,  Z = 1",
            transform=ax.transAxes, ha="right", va="bottom", fontsize=7.8, color=PAL["text"],
            bbox=dict(facecolor="white", edgecolor="#C8D0D8", lw=0.65, alpha=0.95, pad=3.2), zorder=20)

    fig.subplots_adjust(left=0.09, right=0.988, bottom=0.14, top=0.97)
    return save_fig(fig, "Figure2", title="Sealed 720-bar BTCUSDT hierarchical reconstruction")


# ---------------------------------------------------------------------------
# Figure 3: Clean 571-bar negative-case window
# ---------------------------------------------------------------------------
def build_figure3() -> dict:
    apply_master_style()
    data = json.loads(INPUTS["fig3"].read_text("utf-8"))
    st = data["structures"]
    bars = data["bars"]
    assert (len(bars), len(st["normalizedK"]), len(st["fractals"]),
            len(st["strokes"]), len(st["segments"]), len(st["pivots"])) == (571, 354, 166, 52, 0, 0)

    fig, ax = plt.subplots(figsize=(9.0, 3.85))
    draw_price_bars(ax, bars, lw_wick=0.32, lw_body=1.0)
    draw_norm_k(ax, st["normalizedK"], lw=0.38, alpha=0.55)
    draw_strokes(ax, st["strokes"], lw=0.68, dashed=True)
    draw_fractals(ax, st["fractals"], size=12.0, edge="none", edge_lw=0.0)

    ax.set_xlim(-6, 576)
    ax.set_ylim(92720, 94560)
    ax.set_xlabel("Raw closed-bar index")
    ax.set_ylabel("Price (USDT)")
    style_axes(ax)

    handles = [
        Line2D([], [], color=PAL["raw_wick"], lw=1.1, label="Price (raw OHLC)"),
        Line2D([], [], color=PAL["k"], lw=1.0, label="Normalized K"),
        Line2D([], [], marker="^", ls="none", color=PAL["f_top"], markersize=5.2, label="Fractal TOP"),
        Line2D([], [], marker="v", ls="none", color=PAL["f_bot"], markersize=5.2, label="Fractal BOTTOM"),
        Line2D([], [], color=PAL["stroke"], lw=1.0, ls=(0, (2.6, 1.4)), label="Stroke"),
    ]
    leg = ax.legend(handles=handles, loc="upper right", bbox_to_anchor=(0.988, 0.982),
                    ncol=2, frameon=True, fancybox=False, facecolor="white",
                    edgecolor="#C8D0D8", framealpha=0.95, fontsize=7.6,
                    borderpad=0.38, labelspacing=0.25, handlelength=1.75, columnspacing=0.9)
    leg.get_frame().set_linewidth(0.65)
    leg.set_zorder(20)

    ax.text(0.014, 0.048, "BTCUSDT (571 bars):  K = 354,  F = 166,  B = 52,  S = 0,  Z = 0  (no Segment/Pivot)",
            transform=ax.transAxes, ha="left", va="bottom", fontsize=7.8, color=PAL["text"],
            bbox=dict(facecolor="white", edgecolor="#C8D0D8", lw=0.65, alpha=0.95, pad=3.2), zorder=20)

    fig.subplots_adjust(left=0.09, right=0.988, bottom=0.14, top=0.97)
    return save_fig(fig, "Figure3", title="Sealed 571-bar BTCUSDT lower-layer negative-case reconstruction")


# ---------------------------------------------------------------------------
# Figure 4 (MERGED): Initial Pivot + Apex Inset + Four-Clock Causal Timeline
# ---------------------------------------------------------------------------
def build_figure4_merged() -> dict:
    apply_master_style()
    data = json.loads(INPUTS["fig4"].read_text("utf-8"))
    fc = load_720_four_clocks()
    piv_fc = fc["pivot"]
    st = data["structures"]
    pivot = st["pivots"][0]
    g_p = pivot["geometry"]
    assert (float(g_p["ZD"]), float(g_p["ZG"]), float(g_p["DD"]), float(g_p["GG"])) == (94698.7, 95289.5, 94441.8, 95523.5)
    assert pivot["eventRawBarIndex"] == piv_fc["k_event"] == 180
    assert pivot["confirmRawBarIndex"] == piv_fc["k_native"] == 248

    # Tight Pivot y-range up to bar 276 (before bar 285 jump to 96,030), shared x=(-4, 286)
    x_data_max = 276
    x_lim = (-4.0, 288.0)
    vis_bars = [b for b in data["bars"] if b["index"] <= x_data_max]
    vis_k = [k for k in st["normalizedK"] if k["geometry"]["sourceStartRawBarIndex"] <= x_data_max]
    vis_f = [f for f in st["fractals"] if f["eventRawBarIndex"] <= x_data_max]
    vis_b = [b for b in st["strokes"] if b["geometry"]["startRawBarIndex"] <= x_data_max]

    fig, (ax_top, ax_bot) = plt.subplots(
        2, 1, figsize=(9.0, 6.75), sharex=True,
        gridspec_kw={"height_ratios": [1.95, 1.0], "hspace": 0.14},
    )

    # ---- Panel (a): Initial Pivot geometry, apex inset, and vertical clock guides ----
    draw_pivot_box(ax_top, pivot, show_ddgg=True)
    draw_price_bars(ax_top, vis_bars, lw_wick=0.35, lw_body=1.12)
    draw_norm_k(ax_top, vis_k, lw=0.40, alpha=0.55)
    draw_strokes(ax_top, vis_b, lw=0.64, dashed=True)
    draw_segments(ax_top, st["segments"], lw=2.05)
    draw_fractals(ax_top, vis_f, size=13.5, edge="none", edge_lw=0.0)

    # Clean mathematical Segment labels
    seg_specs = [
        (0, r"$S_1$ (Case 1, up)", (6, 5), "left", "bottom"),
        (1, r"$S_2$ (Case 1, down)", (6, -11), "left", "top"),
        (2, r"$S_3$ (Case 1, up)", (6, 5), "left", "bottom"),
    ]
    for idx, lbl, offset, ha, va in seg_specs:
        sg = st["segments"][idx]["geometry"]
        ax_top.annotate(lbl, xy=(sg["endRawBarIndex"], sg["endPrice"]),
                        xytext=offset, textcoords="offset points",
                        fontsize=8.2, color=PAL["segment"], fontweight="medium",
                        ha=ha, va=va, zorder=10)

    # Subtle Pivot price-level tags inside right boundary of Pivot span
    for tag, yval, col, dy in [
        (r"$GG$", float(g_p["GG"]), PAL["muted"], 4),
        (r"$ZG$", float(g_p["ZG"]), PAL["pivot"], 4),
        (r"$ZD$", float(g_p["ZD"]), PAL["pivot"], -9),
        (r"$DD$", float(g_p["DD"]), PAL["muted"], -9),
    ]:
        ax_top.annotate(tag, xy=(177.5, yval), xytext=(0, dy), textcoords="offset points",
                        ha="right", va="center", fontsize=7.6, color=col, zorder=9)

    # Faint alignment drop-lines for S1 and S2 clocks linking Panel (a) -> Panel (b)
    for seg_row in fc["segments"][:2]:
        ax_top.axvline(seg_row["k_event"], color=PAL["event"], lw=0.55, ls=":", alpha=0.35, zorder=1.4)
        ax_top.axvline(seg_row["k_native"], color=PAL["native"], lw=0.60, ls="--", alpha=0.38, zorder=1.4)
        ax_top.axvline(seg_row["k_emit_first"], color=PAL["guard"], lw=0.65, ls="-.", alpha=0.40, zorder=1.4)
        ax_bot.axvline(seg_row["k_event"], color=PAL["event"], lw=0.55, ls=":", alpha=0.32, zorder=1.0)
        ax_bot.axvline(seg_row["k_native"], color=PAL["native"], lw=0.60, ls="--", alpha=0.34, zorder=1.0)
        ax_bot.axvline(seg_row["k_emit_first"], color=PAL["guard"], lw=0.65, ls="-.", alpha=0.36, zorder=1.0)

    # Prominent vertical clock markers for S3 / initial Pivot Z1 (180 / 248 / 254)
    k_ev, k_nat, k_em = piv_fc["k_event"], piv_fc["k_native"], piv_fc["k_emit_first"]
    ax_top.axvline(k_ev, color=PAL["event"], lw=1.05, ls="-", zorder=8)
    ax_top.axvline(k_nat, color=PAL["native"], lw=1.05, ls="--", zorder=8)
    ax_top.axvline(k_em, color=PAL["guard"], lw=1.15, ls="-.", zorder=8)
    ax_bot.axvline(k_ev, color=PAL["event"], lw=0.75, ls="-", alpha=0.55, zorder=1.2)
    ax_bot.axvline(k_nat, color=PAL["native"], lw=0.80, ls="--", alpha=0.60, zorder=1.2)
    ax_bot.axvline(k_em, color=PAL["guard"], lw=0.85, ls="-.", alpha=0.65, zorder=1.2)

    # Non-overlapping Pivot clock labels at bottom of Panel (a)
    ax_top.annotate(f"$t_{{\\mathrm{{event}}}}$ ({k_ev})", xy=(k_ev, 0.025),
                    xycoords=("data", "axes fraction"), xytext=(4, 0), textcoords="offset points",
                    fontsize=7.7, color=PAL["event"], ha="left", va="bottom", zorder=11)
    ax_top.annotate(f"$t_{{\\mathrm{{native}}}}$ ({k_nat})", xy=(k_nat, 0.025),
                    xycoords=("data", "axes fraction"), xytext=(-4, 0), textcoords="offset points",
                    fontsize=7.7, color=PAL["native"], ha="right", va="bottom", zorder=11)
    ax_top.annotate(f"$t_{{\\mathrm{{guard}}}}=t_{{\\mathrm{{emit}}}}$\n({k_em})", xy=(k_em, 0.025),
                    xycoords=("data", "axes fraction"), xytext=(4, 0), textcoords="offset points",
                    fontsize=7.5, color=PAL["guard"], ha="left", va="bottom", linespacing=1.08, zorder=11)

    # Clean latency span brackets at top whitespace of Panel (a)
    y_span = 95585.0
    ax_top.annotate("", xy=(k_nat, y_span), xytext=(k_ev, y_span),
                    arrowprops=dict(arrowstyle="<->", color=PAL["native"], lw=0.85, shrinkA=1, shrinkB=1), zorder=10)
    ax_top.text((k_ev + k_nat) / 2, y_span + 16, r"$+68\;\mathrm{min}$",
                ha="center", va="bottom", fontsize=7.8, color=PAL["native"], zorder=10)
    ax_top.annotate("", xy=(k_em, y_span - 55), xytext=(k_nat, y_span - 55),
                    arrowprops=dict(arrowstyle="-|>", color=PAL["guard"], lw=0.85, shrinkA=0, shrinkB=0), zorder=10)
    ax_top.text(k_em + 3.0, y_span - 55, r"$+6\;\mathrm{min}$",
                ha="left", va="center", fontsize=7.6, color=PAL["guard"],
                bbox=dict(facecolor="white", edgecolor="none", alpha=0.88, pad=0.6), zorder=11)

    ax_top.set_ylim(94270, 95725)
    ax_top.set_ylabel("Price (USDT)")
    ax_top.set_title("(a) Initial Pivot intersection, apex detail inset, and active higher-layer clocks (bars 0–276)",
                     loc="left", fontsize=9.2, pad=4.5)
    ax_top.tick_params(labelbottom=False)
    style_axes(ax_top)

    # Apex detail inset inside Panel (a) (exact frozen bars 44-85)
    inset = ax_top.inset_axes([0.135, 0.125, 0.19, 0.25], zorder=15)
    inset.patch.set_facecolor("white")
    draw_pivot_box(inset, pivot, show_ddgg=False)
    draw_price_bars(inset, [b for b in vis_bars if 44 <= b["index"] <= 85], lw_wick=0.35, lw_body=1.1)
    draw_norm_k(inset, [k for k in vis_k if k["geometry"]["sourceStartRawBarIndex"] <= 85
                        and k["geometry"]["sourceEndRawBarIndex"] >= 44], lw=0.40, alpha=0.55)
    draw_strokes(inset, vis_b, lw=0.64, dashed=True)
    draw_segments(inset, st["segments"], lw=1.55)
    draw_fractals(inset, [f for f in vis_f if 44 <= f["eventRawBarIndex"] <= 85], size=12.0, edge="none", edge_lw=0.0)
    inset.set_xlim(44, 85)
    inset.set_ylim(94920, 95585)
    inset.text(0.03, 0.97, "Apex detail · bars 44–85", transform=inset.transAxes,
               va="top", ha="left", fontsize=6.5, color="#333333", zorder=20,
               bbox=dict(facecolor="white", edgecolor="none", alpha=0.90, pad=0.4))
    inset.tick_params(axis="both", labelsize=6.4, length=2.0, pad=1.4, color="#7A7A7A", labelcolor="#333333", width=0.5)
    for lbl_y in inset.get_yticklabels():
        lbl_y.set_bbox(dict(facecolor="white", edgecolor="none", alpha=0.82, pad=0.5))
    inset.grid(True, color="#ECEFF2", lw=0.35, zorder=0)
    for sp in inset.spines.values():
        sp.set_linewidth(0.55)
        sp.set_edgecolor("#888888")

    apex_x = 68.0
    parent_x = (apex_x - x_lim[0]) / (x_lim[1] - x_lim[0])
    inset_top_x = (parent_x - 0.135) / 0.19
    arrow = ConnectionPatch(
        xyA=(apex_x, 95455.0), coordsA=ax_top.transData,
        xyB=(inset_top_x, 1.0), coordsB=inset.transAxes,
        arrowstyle="-|>", mutation_scale=7.5, shrinkA=0, shrinkB=0,
        lw=1.05, color="#8A3E3C", zorder=19,
    )
    fig.add_artist(arrow)

    # ---- Panel (b): Four-clock causal-availability latency lanes ----
    lanes = [
        (r"$S_1$ (up)", fc["segments"][0]),
        (r"$S_2$ (down)", fc["segments"][1]),
        (r"$S_3$ (up)", fc["segments"][2]),
        (r"$Z_1$ (Pivot)", piv_fc),
    ]
    ys = [3.0, 2.0, 1.0, 0.0]
    bar_h = 0.40
    for y, (label, row) in zip(ys, lanes):
        ke, kn, km = row["k_event"], row["k_native"], row["k_emit_first"]
        dn = kn - ke
        dg = km - kn
        ax_bot.barh(y, dn, left=ke, height=bar_h, color=PAL["native"], alpha=0.78, edgecolor="none", zorder=3)
        ax_bot.barh(y, dg, left=kn, height=bar_h, color=PAL["guard"], alpha=0.88, edgecolor="none", zorder=3.2)
        ax_bot.scatter([ke], [y], marker="o", s=34, color=PAL["event"], edgecolor="white", lw=0.6, zorder=5)
        ax_bot.scatter([kn], [y], marker="s", s=30, color=PAL["native"], edgecolor="white", lw=0.6, zorder=5)
        ax_bot.scatter([km], [y], marker="D", s=30, color=PAL["guard"], edgecolor="white", lw=0.6, zorder=5)

        ax_bot.text((ke + kn) / 2, y, f"+{dn} min", ha="center", va="center",
                    fontsize=7.6, color="white", fontweight="bold", zorder=6)
        ax_bot.text(km + 2.8, y, f"+{dg} (+{dn + dg} min)", ha="left", va="center",
                    fontsize=7.4, color=PAL["guard"], zorder=6)
        ax_bot.text(ke - 3.0, y, f"bar {ke}", ha="right", va="center",
                    fontsize=7.4, color=PAL["muted"], zorder=6)

    ax_bot.set_yticks(ys)
    ax_bot.set_yticklabels([lbl for lbl, _ in lanes], fontsize=8.6)
    ax_bot.set_ylim(-0.62, 3.65)
    ax_bot.set_xlim(*x_lim)
    ax_bot.set_xlabel("Raw closed-bar index")
    ax_bot.set_title("(b) Four-clock causal-availability lag across $S_1$\u2013$S_3$ and $Z_1$ ($t_{\\mathrm{event}} < t_{\\mathrm{native}} < t_{\\mathrm{guard}} = t_{\\mathrm{emit}}$)",
                     loc="left", fontsize=9.2, pad=4.5)
    style_axes(ax_bot, grid_axis="x")
    ax_bot.yaxis.set_major_formatter(plt.FixedFormatter([lbl for lbl, _ in lanes]))

    # Unified 5-column legend strip at top
    handles = [
        Line2D([], [], color=PAL["raw_wick"], lw=1.1, label="Price (raw OHLC)"),
        Line2D([], [], color=PAL["k"], lw=1.0, label="Normalized K"),
        Line2D([], [], marker="^", ls="none", color=PAL["f_top"], markersize=4.8, label="Fractal TOP"),
        Line2D([], [], marker="v", ls="none", color=PAL["f_bot"], markersize=4.8, label="Fractal BOTTOM"),
        Line2D([], [], color=PAL["stroke"], lw=1.0, ls=(0, (2.6, 1.4)), label="Stroke"),
        Line2D([], [], color=PAL["segment"], lw=2.0, label="Segment"),
        Patch(facecolor=PAL["pivot"], edgecolor=PAL["pivot"], alpha=0.25, hatch="//", label="Pivot [ZD, ZG]"),
        Line2D([], [], marker="o", color=PAL["event"], ls="-", lw=1.0, markersize=4.4, label=r"Event ($t_{\mathrm{event}}$)"),
        Line2D([], [], marker="s", color=PAL["native"], ls="--", lw=1.0, markersize=4.4, label=r"Native ($t_{\mathrm{native}}$)"),
        Line2D([], [], marker="D", color=PAL["guard"], ls="-.", lw=1.1, markersize=4.4, label=r"Guard/emit ($t_{\mathrm{guard}}=t_{\mathrm{emit}}$)"),
    ]
    leg = fig.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.535, 0.996),
                     ncol=5, frameon=True, fancybox=False, facecolor="white",
                     edgecolor="#C8D0D8", framealpha=0.96, fontsize=7.35,
                     borderpad=0.35, labelspacing=0.25, handlelength=1.7, columnspacing=0.82)
    leg.get_frame().set_linewidth(0.65)

    fig.subplots_adjust(left=0.095, right=0.988, bottom=0.075, top=0.90)
    return save_fig(fig, "Figure4", title="Initial Pivot intersection, apex inset, and four-clock causal timeline")


# ---------------------------------------------------------------------------
# Figure 5 (formerly Fig 6): Four Fixed July 2026 Cross-Underlying Windows
# ---------------------------------------------------------------------------
def build_figure5() -> tuple[dict, list[Path]]:
    apply_master_style()
    protocol = json.loads(INPUTS["r4_protocol"].read_text("utf-8"))
    symbols = ("BTCUSDT", "ETHUSDT", "XAUUSDT", "SPYUSDT")
    windows = {row["symbol"]: row for row in protocol["windows"] if row["month"] == "2026-07"}
    assert set(windows) == set(symbols)

    r4_files: list[Path] = []
    items = []
    for sym in symbols:
        row = windows[sym]
        wid = row["windowId"]
        csv_p = R4 / "figure-inputs" / f"{wid}.csv"
        run_dir = R4 / "runs" / wid / "A"
        hashes = json.loads((run_dir / "hashes.json").read_text("utf-8"))
        st_p = run_dir / "structures.json"
        res_p = run_dir / "result.json"
        r4_files.extend([csv_p, st_p, res_p, run_dir / "hashes.json"])
        assert sha256(csv_p) == row["csvSha256"], wid
        assert sha256(st_p) == hashes["structuresSha256"], wid
        assert sha256(res_p) == hashes["resultSha256"], wid
        with csv_p.open("r", encoding="utf-8", newline="") as fh:
            bars = [{"index": i, **r} for i, r in enumerate(csv.DictReader(fh))]
        st = json.loads(st_p.read_text("utf-8"))
        res = json.loads(res_p.read_text("utf-8"))
        assert len(bars) == row["barCount"] == res["inputBars"]
        items.append((sym, bars, st, res))

    fig, axes = plt.subplots(4, 1, figsize=(9.0, 6.75), sharex=True, gridspec_kw={"hspace": 0.24})
    for idx, (ax, (sym, bars, st, res)) in enumerate(zip(axes, items)):
        for p in st["pivots"]:
            draw_pivot_box(ax, p, show_ddgg=False)
        draw_price_bars(ax, bars, lw_wick=0.35, lw_body=0.90)
        for item in st["normalizedK"]:
            g = item["geometry"]
            ax.vlines(g["sourceEndRawBarIndex"], g["low"], g["high"],
                      color=PAL["k"], lw=0.60, alpha=0.58, zorder=3.0)
        draw_strokes(ax, st["strokes"], lw=0.72, dashed=False)
        draw_segments(ax, st["segments"], lw=2.05)
        draw_fractals(ax, st["fractals"], size=13.5, edge="white", edge_lw=0.25)

        ax.set_xlim(-6, len(bars) + 4)
        lo = min(float(b["low"]) for b in bars)
        hi = max(float(b["high"]) for b in bars)
        pad = (hi - lo) * 0.08
        ax.set_ylim(lo - pad, hi + pad)
        ax.set_title(f"({chr(97 + idx)}) {sym}", loc="left", fontsize=9.2, pad=3.0)
        c = res["counts"]
        suffix = "  (no Segment/Pivot)" if c["S"] == 0 and c["Z"] == 0 else ""
        badge = f"K = {c['K']},  F = {c['F']},  B = {c['B']},  S = {c['S']},  Z = {c['Z']}{suffix}"
        ax.text(0.990, 0.94, badge, transform=ax.transAxes, ha="right", va="top",
                fontsize=7.35, color=PAL["text"],
                bbox=dict(facecolor="white", edgecolor="#D0D7DE", lw=0.55, alpha=0.92, pad=2.3), zorder=20)
        if idx < 3:
            ax.tick_params(labelbottom=False)
        style_axes(ax)

    fig.supylabel("Price (USDT)", fontsize=9.5, x=0.018)
    axes[-1].set_xlabel("Raw closed-bar index")

    handles = [
        Line2D([], [], color=PAL["raw_wick"], lw=1.1, label="Price (raw OHLC)"),
        Line2D([], [], color=PAL["k"], lw=1.0, label="Normalized K"),
        Line2D([], [], marker="^", ls="none", color=PAL["f_top"], markersize=5.0, label="Fractal TOP"),
        Line2D([], [], marker="v", ls="none", color=PAL["f_bot"], markersize=5.0, label="Fractal BOTTOM"),
        Line2D([], [], color=PAL["stroke"], lw=1.0, label="Stroke"),
        Line2D([], [], color=PAL["segment"], lw=2.0, label="Segment"),
    ]
    leg = fig.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.535, 0.994),
                     ncol=6, frameon=True, fancybox=False, facecolor="white",
                     edgecolor="#C8D0D8", framealpha=0.96, fontsize=7.6,
                     borderpad=0.35, handlelength=1.65, columnspacing=0.95)
    leg.get_frame().set_linewidth(0.65)

    fig.subplots_adjust(left=0.095, right=0.988, bottom=0.068, top=0.925)
    return save_fig(fig, "Figure5", title="Cross-underlying structural reconstructions across four July 2026 windows"), r4_files


# ---------------------------------------------------------------------------
# Figure 6 (formerly Fig 7): Native Confirmation-Clock Offsets
# ---------------------------------------------------------------------------
def build_figure6() -> dict:
    apply_master_style()
    data = json.loads(INPUTS["fig6_delay"].read_text("utf-8"))
    assert data["status"] == "PASS"

    W, H = 590.0, 276.0
    fig = plt.figure(figsize=(W / 72.0, H / 72.0))

    def ftext(x, y, s, size=8.6, ha="left", color=PAL["text"], weight="normal", **kw):
        return fig.text(x / W, y / H, s, ha=ha, va="center", fontsize=size,
                        color=color, fontweight=weight, **kw)

    def hrule(y, x0, x1, color="#D5DCE2", lw=0.55):
        fig.add_artist(Line2D([x0 / W, x1 / W], [y / H, y / H],
                              transform=fig.transFigure, color=color, lw=lw))

    ftext(14, 258, "(a) Lower structural layers", size=9.6, weight="medium")
    ftext(14, 232, "Structural layer", size=8.4, color=PAL["muted"])
    ftext(130, 232, "Reported\noffset (min)", size=8.4, ha="center", color=PAL["muted"], linespacing=1.12)
    ftext(184, 232, "Total\nN", size=8.4, ha="right", color=PAL["muted"], linespacing=1.12)
    hrule(216, 14, 184, color="#9AA5B1", lw=0.7)

    low_med = data["pooledLowMediansIndependentlyVerified"]
    totals = data["totals"]
    for y, lbl, med, n_val in [
        (188, "Normalized K-line", low_med["normalizedK"], totals["normalizedK"]),
        (134, "Fractal", low_med["fractals"], totals["fractals"]),
        (80, "Stroke", low_med["strokes"], totals["strokes"]),
    ]:
        ftext(14, y, lbl, size=8.8)
        ftext(130, y, f"{med:g}", size=9.2, ha="center", weight="medium")
        ftext(184, y, f"{n_val:,}", size=8.8, ha="right")
    for y in (161, 107, 54):
        hrule(y, 14, 184)

    ftext(206, 258, "(b) Higher structural layers", size=9.6, weight="medium")
    ftext(206, 232, "Instrument", size=8.4, color=PAL["muted"])
    ftext(268, 232, "Layer", size=8.4, color=PAL["muted"])
    ftext(548, 232, "Median\n(min)", size=8.4, ha="right", color=PAL["muted"], linespacing=1.12)
    ftext(574, 232, "n", size=8.4, ha="right", color=PAL["muted"])
    hrule(216, 206, 574, color="#9AA5B1", lw=0.7)

    ax_l, ax_b, ax_w, ax_h = 328.0, 58.0, 192.0, 152.0
    ax = fig.add_axes([ax_l / W, ax_b / H, ax_w / W, ax_h / H])
    ax.set_xlim(0, 132)
    ax.set_ylim(0, 11.4)
    ax.set_yticks([])
    ax.set_xticks([0, 30, 60, 90, 120])
    ax.tick_params(axis="x", labelsize=8.2, length=3.0, width=0.65, pad=3.5)
    ax.grid(axis="x", color=PAL["grid"], lw=0.55)
    ax.set_axisbelow(True)
    for sp in ("left", "right", "top"):
        ax.spines[sp].set_visible(False)
    ax.spines["bottom"].set_color(PAL["axis"])
    ax.spines["bottom"].set_linewidth(0.75)
    ax.set_xlabel("Native confirmation-clock offset (min)", fontsize=8.6, labelpad=5.5)

    piv_obs_by_sym: dict[str, list[float]] = {}
    for obs in data["pivotObservations"]:
        piv_obs_by_sym.setdefault(obs["symbol"], []).append(float(obs["delayMinutes"]))

    ys = [10.45, 9.45, 7.65, 6.65, 4.85, 3.85, 2.05, 1.05]

    def yfig(yv: float) -> float:
        return ax_b + ax_h * yv / 11.4

    for i, sym in enumerate(["BTCUSDT", "ETHUSDT", "XAUUSDT", "SPYUSDT"]):
        ftext(206, yfig((ys[2 * i] + ys[2 * i + 1]) / 2.0), sym, size=8.7, weight="medium")
        for j, (layer, lbl, col) in enumerate([
            ("segments", "Segment", PAL["stat_seg"]),
            ("pivots", "Initial Pivot", PAL["stat_piv"]),
        ]):
            row = next(v for v in data["rows"] if v["symbol"] == sym and v["layer"] == layer)
            yv = ys[2 * i + j]
            ftext(268, yfig(yv), lbl, size=8.5)
            ax.barh(yv, row["medianMinutes"], left=0, height=0.58,
                    color=col, edgecolor=col, lw=0.3, zorder=3)
            if layer == "pivots" and sym in piv_obs_by_sym:
                pts = piv_obs_by_sym[sym]
                ax.scatter(pts, [yv] * len(pts), marker="o", s=22,
                           facecolor="white", edgecolor="#3B2314", lw=0.95, zorder=5)
            ftext(548, yfig(yv), f"{row['medianMinutes']:g}", size=8.6, ha="right")
            ftext(574, yfig(yv), str(row["N"]), size=8.6, ha="right")
        if i < 3:
            hrule(yfig((ys[2 * i + 1] + ys[2 * i + 2]) / 2.0), 206, 574)

    leg_handles = [
        Patch(facecolor=PAL["stat_seg"], edgecolor="none", label="Segment median"),
        Patch(facecolor=PAL["stat_piv"], edgecolor="none", label="Initial Pivot median"),
        Line2D([], [], marker="o", ls="none", markersize=4.6, markerfacecolor="white",
               markeredgecolor="#3B2314", markeredgewidth=0.95, label="Individual Pivot obs."),
    ]
    fig.legend(handles=leg_handles, loc="lower left", bbox_to_anchor=(14 / W, 10 / H),
               ncol=3, frameon=False, fontsize=7.5, handlelength=1.2, columnspacing=1.2)

    return save_fig(fig, "Figure6", title="Native confirmation-clock offsets across 12 fixed windows", tight=False)


# ---------------------------------------------------------------------------
# Figure 7 (formerly Fig 8): Computational Scaling (Log-Log)
# ---------------------------------------------------------------------------
def build_figure7() -> dict:
    apply_master_style()
    result = json.loads(INPUTS["fig7_scaling_result"].read_text("utf-8"))
    protocol = json.loads(INPUTS["fig7_scaling_protocol"].read_text("utf-8"))["E5-X"]
    ablation = json.loads(EXP2_ABLATION.read_text("utf-8"))

    locked = {120: 0.662, 500: 18.314, 1000: 170.349, 2000: 424.475}
    by_n = {row["bars"]: row for row in result["scalingPoints"]}
    for n, sec in locked.items():
        assert by_n[n]["status"] == "COMPLETED"
        assert abs(by_n[n]["meanTotalRuntimeMs"] * 0.001 - sec) <= 0.001
    for n in (5000, 10000):
        assert by_n[n]["status"] == "RESOURCE_LIMIT_TIMEOUT"
        assert by_n[n].get("meanTotalRuntimeMs") is None
    threshold_s = protocol["workerTimeoutMs"] * 0.001
    assert threshold_s == 600.0

    completed = sorted((r for r in result["scalingPoints"] if r["status"] == "COMPLETED"), key=lambda x: x["bars"])
    timed_out = sorted((r for r in result["scalingPoints"] if r["status"] == "RESOURCE_LIMIT_TIMEOUT"), key=lambda x: x["bars"])

    # Sandbox controlled ablation curves (verified bit-for-bit structurally identical)
    grid = ablation["scalingGrid"]
    exp_map = ablation["empiricalScalingExponents"]
    xs_nh = [r["bars"] for r in grid if "no_step_hash" in r["modes"]]
    ys_nh = [r["modes"]["no_step_hash"]["meanTotalRuntimeSec"] for r in grid if "no_step_hash" in r["modes"]]
    xs_off = [r["bars"] for r in grid if "audit_hooks_off" in r["modes"]]
    ys_off = [r["modes"]["audit_hooks_off"]["meanTotalRuntimeSec"] for r in grid if "audit_hooks_off" in r["modes"]]
    assert all(r["allExecutedModesExactMatch"] for r in grid)

    fig, ax = plt.subplots(figsize=(7.6, 4.15))
    ax.set_xscale("log")
    ax.set_yscale("log")

    ax.axhspan(threshold_s, 1450, facecolor=PAL["watchdog"], alpha=0.065, zorder=1)
    ax.axhline(threshold_s, color=PAL["watchdog"], lw=0.95, ls=(0, (4.5, 3.0)), alpha=0.85, zorder=2)
    ax.text(112, threshold_s * 1.14, "600 s watchdog censoring threshold",
            ha="left", va="bottom", fontsize=7.9, color=PAL["watchdog"], zorder=5)

    # Curve 1: Frozen E5-X full-audit baseline
    xs_c = [r["bars"] for r in completed]
    ys_c = [r["meanTotalRuntimeMs"] * 0.001 for r in completed]
    ax.plot(xs_c, ys_c, color=PAL["completed"], lw=1.85, marker="o", markersize=5.8,
            markeredgecolor="white", markeredgewidth=0.65,
            label=rf"Frozen full-audit baseline ($\alpha={exp_map['frozen_full_audit_120_2000']:.2f}$)", zorder=5)

    offsets_c = [(0, 8, "center", "bottom"), (-7, 7, "right", "bottom"),
                 (-8, 6, "right", "bottom"), (-5, 8, "right", "bottom")]
    for (x, y), (dx, dy, ha, va) in zip(zip(xs_c, ys_c), offsets_c):
        lbl = f"{y:.2f} s" if y < 10 else f"{y:.1f} s"
        ax.annotate(lbl, (x, y), xytext=(dx, dy), textcoords="offset points",
                    ha=ha, va=va, fontsize=7.6, color=PAL["completed"], fontweight="medium", zorder=7)

    # Censored watchdog points
    ax.scatter([r["bars"] for r in timed_out], [threshold_s] * len(timed_out),
               marker="^", s=56, facecolors="white", edgecolors=PAL["watchdog"],
               linewidths=1.35, label="Full-audit watchdog reached (\u2265600 s, censored)", zorder=6)

    # Curve 2: Per-step hashing disabled (single-factor)
    ax.plot(xs_nh, ys_nh, color=PAL["stat_piv"], lw=1.55, ls="--", marker="s", markersize=5.0,
            markeredgecolor="white", markeredgewidth=0.55,
            label=rf"Per-step hashing disabled ($\alpha={exp_map['no_step_hash_120_2000']:.2f}$)", zorder=4.5)
    offsets_nh = [(8, -3, "left", "center"), (8, -2, "left", "center"),
                  (8, -2, "left", "center"), (9, 0, "left", "center")]
    for (x, y), (dx, dy, ha, va) in zip(zip(xs_nh, ys_nh), offsets_nh):
        lbl = f"{y:.2f} s" if y < 10 else f"{y:.1f} s"
        ax.annotate(lbl, (x, y), xytext=(dx, dy), textcoords="offset points",
                    ha=ha, va=va, fontsize=7.3, color="#A85A17", zorder=7)

    # Curve 3: All non-semantic audit hooks disabled
    ax.plot(xs_off, ys_off, color=PAL["k"], lw=1.7, ls="-.", marker="D", markersize=4.8,
            markeredgecolor="white", markeredgewidth=0.55,
            label=rf"All non-semantic audit hooks off ($\alpha={exp_map['audit_hooks_off_500_5000']:.2f}$)", zorder=4.8)
    offsets_off = [(7, -4, "left", "top"), (7, -6, "left", "top"),
                   (7, -6, "left", "top"), (7, -6, "left", "top"), (7, -3, "left", "center")]
    for (x, y), (dx, dy, ha, va) in zip(zip(xs_off, ys_off), offsets_off):
        lbl = f"{y:.2f} s" if y < 10 else f"{y:.1f} s"
        ax.annotate(lbl, (x, y), xytext=(dx, dy), textcoords="offset points",
                    ha=ha, va=va, fontsize=7.5, color="#007A59", fontweight="medium", zorder=7)

    # Speedup annotation at N=2000 (424.5 s -> 28.0 s = 15.2x)
    y_top_2k = locked[2000]
    y_bot_2k = ys_off[xs_off.index(2000)]
    speedup_2k = y_top_2k / y_bot_2k
    ax.annotate("", xy=(2000, y_bot_2k * 1.18), xytext=(2000, y_top_2k * 0.85),
                arrowprops=dict(arrowstyle="<->", color="#52606D", lw=0.85, ls=":"), zorder=3.5)
    ax.text(2130, 82.0, f"{speedup_2k:.1f}\u00d7",
            ha="left", va="center", fontsize=7.9, color="#333333", fontweight="bold",
            bbox=dict(facecolor="white", edgecolor="none", alpha=0.92, pad=0.8), zorder=6)

    ax.set_xlim(95, 13800)
    ax.set_ylim(0.046, 1450)
    ax.xaxis.set_major_locator(FixedLocator(protocol["requiredN"]))
    ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{int(x):,}"))
    ax.xaxis.set_minor_locator(NullLocator())
    ax.yaxis.set_major_locator(FixedLocator([0.1, 1, 10, 100, 600]))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda y, _: f"{y:g}"))
    ax.yaxis.set_minor_locator(NullLocator())
    ax.set_xlabel(r"Closed bars, $N$")
    ax.set_ylabel("Total runtime (s)")
    style_axes(ax, grid_axis="y")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda y, _: f"{y:g}"))

    leg = ax.legend(loc="lower right", bbox_to_anchor=(0.985, 0.035), borderaxespad=0.0,
                    frameon=True, fancybox=False, facecolor="white", edgecolor="#C8D0D8",
                    framealpha=0.96, fontsize=7.45, borderpad=0.40, labelspacing=0.30, handlelength=2.1)
    leg.get_frame().set_linewidth(0.65)

    fig.subplots_adjust(left=0.105, right=0.982, bottom=0.138, top=0.962)
    return save_fig(fig, "Figure7", title="Computational scaling and audit-overhead ablation on logarithmic axes")


# ---------------------------------------------------------------------------
# Figure 8 (formerly Fig 9): 14-Window Cross-Implementation Heatmap
# ---------------------------------------------------------------------------
def build_figure8() -> dict:
    apply_master_style()
    data = json.loads(INPUTS["fig8_heatmap"].read_text("utf-8"))
    assert data["status"] == "PASS"

    W, H = 620.0, 560.0
    fig = plt.figure(figsize=(W / 72.0, H / 72.0))
    cmap = LinearSegmentedColormap.from_list(
        "PhysicaA_LinearBlue",
        [(0.0, "#F7FAFC"), (0.2, "#C6DBEF"), (0.4, "#6BAED6"),
         (0.6, "#3182BD"), (0.8, "#08519C"), (1.0, "#08306B")],
        N=256,
    )
    norm = Normalize(vmin=0.0, vmax=1.0, clip=False)

    def lum(rgb):
        a = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb[:3]]
        return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]

    def contrast(c1, c2):
        l1, l2 = sorted((lum(c1), lum(c2)))
        return (l2 + 0.05) / (l1 + 0.05)

    def ftext(x, y, s, size=8.6, ha="left", color=PAL["text"], weight="normal"):
        return fig.text(x / W, y / H, s, ha=ha, va="center", fontsize=size, color=color, fontweight=weight)

    def hrule(x0, x1, y, color="#B8C4CE", lw=0.5):
        fig.add_artist(Line2D([x0 / W, x1 / W], [y / H, y / H],
                              transform=fig.transFigure, color=color, lw=lw, zorder=8))

    top = 516.0
    row_h = 32.5
    gap = 9.0
    col_w = 43.0
    panel_w = 4 * col_w
    panel_left = [184.0, 374.0]
    centers = [top - (i + 0.5) * row_h - sum(i >= n for n in (5, 8, 11)) * gap for i in range(14)]
    bottom = top - 14 * row_h - 3 * gap

    for a, x_left in enumerate(panel_left):
        ftext(x_left, 542.0,
              "(a) Unique correspondence" if a == 0 else "(b) Exact correspondence",
              size=9.5, weight="medium")
        for j, col_lbl in enumerate(["K", "F", "B", r"$S^*$"]):
            ftext(x_left + (j + 0.5) * col_w, bottom - 16.0, col_lbl, size=9.2, ha="center", weight="medium")
        for i, yc in enumerate(centers):
            for j in range(4):
                panel_name = "Unique" if a == 0 else "Exact"
                r = next(v for v in data["rows"] if v["panel"] == panel_name and v["row"] == i and v["column"] == j)
                val = r["storedRate"]
                assert val is not None
                rgba = tuple(float(v) for v in cmap(norm(val)))
                black, white = (0.055, 0.10, 0.14), (1.0, 1.0, 1.0)
                tc = white if contrast(rgba, white) > contrast(rgba, black) else black
                assert contrast(rgba, tc) >= 4.5
                x0 = x_left + j * col_w
                y0 = yc - row_h / 2.0
                fig.add_artist(Rectangle((x0 / W, y0 / H), col_w / W, row_h / H,
                                         transform=fig.transFigure, facecolor=rgba,
                                         edgecolor="white", lw=0.65, zorder=1))
                ftext(x0 + col_w / 2.0, yc, r["displayText"], size=8.6, ha="center", color=tc)
        fig.add_artist(Line2D([(x_left + 2 * col_w) / W] * 2, [bottom / H, top / H],
                              transform=fig.transFigure, color="white", lw=1.6, zorder=5))
        for split in (5, 8, 11):
            hrule(x_left, x_left + panel_w, (centers[split - 1] + centers[split]) / 2.0)

    for start, end in ((0, 5), (5, 8), (8, 11), (11, 14)):
        d0 = data["displayOrder"][start]
        inst = next(v["instrument"] for v in data["windows"] if v["datasetId"] == d0["datasetId"])
        ftext(14.0, (centers[start] + centers[end - 1]) / 2.0, inst, size=9.0, weight="medium")
    for i in range(14):
        r = next(v for v in data["rows"] if v["panel"] == "Unique" and v["row"] == i)
        ftext(176.0, centers[i], f"{r['dateUTC']} ({r['bars']})", size=8.4, ha="right", color=PAL["muted"])
    for split in (5, 8, 11):
        hrule(14.0, 176.0, (centers[split - 1] + centers[split]) / 2.0)

    cax = fig.add_axes([564.0 / W, bottom / H, 9.5 / W, (top - bottom) / H])
    cb = fig.colorbar(ScalarMappable(norm=norm, cmap=cmap), cax=cax, ticks=[0, 0.2, 0.4, 0.6, 0.8, 1.0])
    cb.solids.set_rasterized(False)
    cb.solids.set_edgecolor("face")
    cb.solids.set_linewidth(0.25)
    cb.ax.set_yticklabels(["0%", "20%", "40%", "60%", "80%", "100%"])
    cb.ax.tick_params(labelsize=8.2, length=2.4, width=0.55, pad=3.0)
    cb.outline.set_linewidth(0.55)
    cb.outline.set_edgecolor("#8999A6")

    return save_fig(fig, "Figure8", title="Window-level cross-implementation correspondence across 14 windows", tight=False)


# ---------------------------------------------------------------------------
# Figure 9 (formerly Fig 10): 571-bar Internal vs External Projections
# ---------------------------------------------------------------------------
def build_figure9() -> dict:
    apply_master_style()
    d = json.loads(INPUTS["fig9_r7c"].read_text("utf-8"))

    fig, axes = plt.subplots(2, 1, figsize=(9.0, 5.85), sharex=True, sharey=True,
                             gridspec_kw={"hspace": 0.22})
    for idx, (ax, side) in enumerate(zip(axes, ("internal", "external"))):
        norm_side = d["normalized"][side]
        status = {}
        for l_key, m in d["matches"]["layers"].items():
            status[l_key] = {p[side + "Id"]: "PAIRED" for p in m["pairs"]}
            status[l_key].update({x: "AMBIGUOUS" for x in m["ambiguousInternal" if side == "internal" else "ambiguousExternal"]})

        for b in d["bars"]:
            x = b["index"]
            o, c = b["open"], b["close"]
            ax.vlines(x, b["low"], b["high"], color=PAL["raw_wick"], lw=0.45, alpha=0.65, zorder=1)
            if o == c:
                ax.hlines(o, x - 0.34, x + 0.34, color=PAL["raw_wick"], lw=0.45, zorder=2)
            else:
                ax.add_patch(Rectangle(
                    (x - 0.34, min(o, c)), 0.68, abs(c - o),
                    facecolor=PAL["raw_up"] if c >= o else "#333333",
                    edgecolor=PAL["raw_wick"], lw=0.40, alpha=0.65, zorder=2,
                ))

        for r in norm_side["K"]:
            if not r["eligible"]:
                continue
            a, b_idx = r["rawSupportStart"], r["rawSupportEnd"]
            ax.add_patch(Rectangle(
                (a - 0.45, r["low"]), b_idx - a + 0.9, r["high"] - r["low"],
                fill=False, edgecolor=PAL["k"], lw=0.48, alpha=0.52, zorder=3,
            ))

        for l_key, col in (("S", PAL["segment"]), ("B", PAL["stroke"])):
            for r in norm_side[l_key]:
                st_flag = status[l_key].get(r["id"], "SIDE_ONLY")
                unsure = not r["eligible"]
                if unsure and (side == "internal" or not str(r.get("exclusionReason", "")).startswith("NATIVE_UNSURE")):
                    continue
                ax.plot([r["startRawIndex"], r["endRawIndex"]], [r["startPrice"], r["endPrice"]],
                        color=col, lw=0.95 if l_key == "B" else 0.90,
                        alpha=0.35 if unsure else (0.95 if l_key == "B" else 0.72),
                        linestyle=":" if unsure else ("-" if st_flag == "PAIRED" else (0, (3.2, 1.8))),
                        zorder=5 if l_key == "B" else 4)
                if not unsure and st_flag == "SIDE_ONLY":
                    ax.scatter([r["endRawIndex"]], [r["endPrice"]], s=18,
                               facecolor="white", edgecolor=col, lw=0.65, zorder=7)
                if not unsure and st_flag == "AMBIGUOUS":
                    ax.scatter([r["endRawIndex"]], [r["endPrice"]], s=34,
                               facecolor="none", edgecolor="#777777", lw=0.65, zorder=7)

        for r in norm_side["F"]:
            if not r["eligible"]:
                continue
            st_flag = status["F"].get(r["id"], "SIDE_ONLY")
            is_top = r["direction"] == "TOP"
            col = PAL["f_top"] if is_top else PAL["f_bot"]
            xpos = r["eventRawIndex"] if side == "internal" else r["geometricPeakRawIndex"]
            ax.scatter([xpos], [r["price"]], marker="^" if is_top else "v", s=19,
                       facecolor=col if st_flag == "PAIRED" else "white",
                       edgecolor="white" if st_flag == "PAIRED" else col,
                       linewidth=0.35 if st_flag == "PAIRED" else 0.75, zorder=6)
            if st_flag == "AMBIGUOUS":
                ax.scatter([xpos], [r["price"]], s=38, facecolor="none", edgecolor="#777777", lw=0.65, zorder=7)

        cnt = "  ".join(f"{'S*' if l_k == 'S' else l_k}={sum(r['eligible'] for r in norm_side[l_k])}" for l_k in "KFBS")
        unsure_n = sum(str(r.get("exclusionReason", "")).startswith("NATIVE_UNSURE")
                       for l_k in "BS" for r in norm_side[l_k])
        if unsure_n:
            cnt += f"  |  {unsure_n} native-unsure excluded"
        ax.text(0.990, 0.955, cnt, ha="right", va="top", transform=ax.transAxes, fontsize=7.6,
                bbox=dict(facecolor="white", edgecolor="#C8D0D8", lw=0.60, alpha=0.95, pad=2.8), zorder=20)
        ax.set_ylabel("Price (USDT)")
        ax.set_title(f"({chr(97 + idx)}) {'Internal implementation' if side == 'internal' else 'External implementation'}",
                     loc="left", fontsize=9.3, pad=4.0)
        style_axes(ax)

    bars = d["bars"]
    lo = min(b["low"] for b in bars)
    hi = max(b["high"] for b in bars)
    pad = (hi - lo) * 0.075
    axes[0].set_ylim(lo - pad, hi + pad)
    axes[0].set_xlim(-4, len(bars) + 3)
    axes[1].set_xlabel("Raw closed-bar index")

    handles = [
        Line2D([], [], color=PAL["raw_wick"], lw=0.9, label="Raw OHLC"),
        Line2D([], [], color=PAL["k"], lw=0.8, alpha=0.7, label="Normalized K"),
        Line2D([], [], marker="^", ls="none", color=PAL["f_top"], markersize=4.8, label="Fractal TOP"),
        Line2D([], [], marker="v", ls="none", color=PAL["f_bot"], markersize=4.8, label="Fractal BOTTOM"),
        Line2D([], [], color=PAL["stroke"], lw=1.05, label="Stroke"),
        Line2D([], [], color=PAL["segment"], lw=1.05, alpha=0.85, label=r"Segment ($S^*$)"),
        Line2D([], [], color="#333333", lw=1.0, ls="-", marker="o", markersize=3.8, label="Solid / filled: matched"),
        Line2D([], [], color="#333333", lw=1.0, ls=(0, (3.2, 1.8)), marker="o", markersize=3.8,
               markerfacecolor="white", label="Dashed / hollow: side-only"),
        Line2D([], [], color=PAL["segment"], lw=0.95, ls=":", alpha=0.65, label="Dotted: native-unsure (excluded)"),
    ]
    leg = fig.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.535, 0.996),
                     ncol=3, frameon=True, fancybox=False, facecolor="white",
                     edgecolor="#C8D0D8", framealpha=0.96, fontsize=7.5,
                     borderpad=0.38, labelspacing=0.28, handlelength=1.8, columnspacing=1.15)
    leg.get_frame().set_linewidth(0.65)

    fig.subplots_adjust(left=0.095, right=0.988, bottom=0.09, top=0.845)
    return save_fig(fig, "Figure9", title="Internal versus External projections on the 571-bar BTCUSDT window")


def main() -> None:
    pre_hashes = {k: sha256(p) for k, p in INPUTS.items()}

    # Remove stale Figure10 assets from earlier 10-figure layout so folder is 100% clean
    for stale in (OUT_ROOT / "Figure10.pdf", PREVIEWS / "Figure10.png"):
        if stale.exists():
            stale.unlink()

    results = []
    results.append(build_figure2())
    results.append(build_figure3())
    results.append(build_figure4_merged())
    res5, r4_files = build_figure5()
    results.append(res5)
    results.append(build_figure6())
    results.append(build_figure7())
    results.append(build_figure8())
    results.append(build_figure9())

    if FIG1_SRC.exists():
        shutil.copy2(FIG1_SRC, OUT_ROOT / "Figure1.pdf")

    post_hashes = {k: sha256(p) for k, p in INPUTS.items()}
    assert pre_hashes == post_hashes, "FROZEN_INPUT_MUTATION_DETECTED"

    audit = {
        "pipeline": "PhysicaA-Unified-Figure-Redraw-v2.0-OptionA-9Figures",
        "pythonVersion": sys.version,
        "matplotlibVersion": matplotlib.__version__,
        "numpyVersion": np.__version__,
        "parserExecuted": False,
        "structuresRecomputed": False,
        "frozenInputsUnchanged": True,
        "frozenInputSha256": pre_hashes,
        "r4CheckedFileCount": len(r4_files),
        "outputs": results,
    }
    audit_path = OUT_ROOT / "physicaA_figure_audit.json"
    audit_path.write_text(json.dumps(audit, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"ALL_8_PROGRAMMATIC_FIGURES_RENDERED_OK (9-figure suite) | audit={audit_path}")
    for r in results:
        print(f"  {r['figure']}: bytes={r['bytes']} type3={r['type3Font']} raster={r['rasterImage']} sha256={r['pdfSha256'][:12]}")


if __name__ == "__main__":
    main()
