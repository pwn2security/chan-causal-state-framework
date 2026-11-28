"""Publication-grade vector figure suite for Physica A manuscript.

Generates pure vector PDFs (pdf.fonttype=42, zero Type 3, zero raster images)
plus 300-DPI PNG previews strictly from frozen verified CSV/JSON artifacts:
  - Figure4.pdf : Dual-Axis 6-Model Null Decomposition, Finite-Size Scaling & Per-Date Consistency
  - Figure5.pdf : Extended Four-Clock Look-Ahead Distortion (1m mB=2, TQ-GBM Control, mB=4, 15m)
  - Figure6.pdf : 14-Window Cross-Implementation Heatmap + CF-1..CF-4 Super-Additive Counterfactuals
  - Figure8.pdf : Four-Tier Computational Scaling (Repeated vs Contiguous 10,000-Bar Real BTCUSDT)

All directories default to repository-relative paths and can be overridden via
environment variables: CT_RESULTS_DIR, CT_FIGURES_OUT, CT_EXP2_ABLATION,
CT_HEATMAP_JSON, CT_E5X_JSON.
"""
from __future__ import annotations

import csv
import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MPL_CACHE = Path(os.environ.get("MPLCONFIGDIR", str(REPO_ROOT / ".mpl-cache")))
MPL_CACHE.mkdir(parents=True, exist_ok=True)
os.environ["MPLCONFIGDIR"] = str(MPL_CACHE)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.cm import ScalarMappable
from matplotlib.colors import LinearSegmentedColormap, Normalize
from matplotlib.lines import Line2D
from matplotlib.patches import Patch, Rectangle
from matplotlib.ticker import FixedLocator, FuncFormatter, NullLocator

R8_DIR = Path(os.environ.get("CT_RESULTS_DIR", str(REPO_ROOT / "manifests" / "results_summary")))
OUT_DIR = Path(os.environ.get("CT_FIGURES_OUT", str(REPO_ROOT / "figures" / "output")))
PREV_DIR = OUT_DIR / "previews"
OUT_DIR.mkdir(parents=True, exist_ok=True)
PREV_DIR.mkdir(parents=True, exist_ok=True)

EXP2_ABLATION = Path(os.environ.get("CT_EXP2_ABLATION", str(R8_DIR / "scaling_audit_ablation.json")))
FIG6_HEATMAP = Path(os.environ.get("CT_HEATMAP_JSON", str(R8_DIR / "chanpy_correspondence_summary.json")))
FIG8_E5X = Path(os.environ.get("CT_E5X_JSON", str(R8_DIR / "baseline_repeated_scaling_full_audit.json")))

PAL = {
    "real": "#1F2933",
    "shuf": "#D55E00",
    "cbb": "#009E73",
    "cgbm": "#9AA5B1",
    "tgbm": "#0072B2",
    "tgarch": "#CC79A7",
    "event": "#D55E00",
    "native": "#0072B2",
    "emit": "#009E73",
    "seg_ev": "#A61C3C",
    "seg_em": "#52606D",
    "amber": "#E69F00",
    "sky": "#56B4E9",
    "axis": "#333333",
    "grid": "#E6EAEE",
    "text": "#1F2933",
    "muted": "#52606D",
    "crimson": "#A61C3C",
}


def r1(v: float) -> str:
    """Standard half-up 1-decimal rounding."""
    s = 1.0 if v >= 0 else -1.0
    return f"{s * (int(abs(v) * 10 + 0.5000001) / 10.0):.1f}"


def apply_style() -> None:
    plt.rcdefaults()
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["DejaVu Sans"],
        "mathtext.fontset": "dejavusans",
        "font.size": 8.5,
        "axes.titlesize": 9.2,
        "axes.labelsize": 8.8,
        "xtick.labelsize": 7.8,
        "ytick.labelsize": 7.8,
        "legend.fontsize": 7.3,
        "axes.linewidth": 0.7,
        "axes.edgecolor": PAL["axis"],
        "axes.labelcolor": PAL["text"],
        "xtick.color": PAL["axis"],
        "ytick.color": PAL["axis"],
        "text.color": PAL["text"],
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "savefig.facecolor": "white",
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    })


def style_ax(ax, grid_axis="y"):
    ax.set_axisbelow(True)
    ax.grid(True, axis=grid_axis, which="major", color=PAL["grid"], lw=0.5, zorder=0)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    for sp in ("left", "bottom"):
        ax.spines[sp].set_color(PAL["axis"])
        ax.spines[sp].set_linewidth(0.7)
    ax.tick_params(length=3.0, width=0.65, pad=2.5)


def parse_pm(s: str) -> tuple[float, float]:
    parts = s.split("+/-")
    return float(parts[0].strip()), float(parts[1].strip())


def read_panelA(path: Path) -> dict[str, dict[str, tuple[float, float]]]:
    out: dict[str, dict[str, tuple[float, float]]] = {}
    with path.open("r", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            m = r["Metric"]
            out[m] = {}
            for k in ("Real", "shuffled_L1", "cbb_L30", "cont_gbm", "tq_gbm", "tq_garch"):
                if k in r and r[k]:
                    out[m][k] = parse_pm(r[k])
    return out


def save_vec(fig, name: str, title: str, tight=True) -> None:
    pdf = OUT_DIR / f"{name}.pdf"
    png = PREV_DIR / f"{name}.png"
    kw = dict(metadata={"Title": title, "CreationDate": None, "ModDate": None})
    if tight:
        fig.savefig(pdf, format="pdf", bbox_inches="tight", pad_inches=0.06, **kw)
        fig.savefig(png, format="png", dpi=300, bbox_inches="tight", pad_inches=0.06)
    else:
        fig.savefig(pdf, format="pdf", **kw)
        fig.savefig(png, format="png", dpi=300)
    plt.close(fig)
    raw = pdf.read_bytes()
    assert b"/Subtype /Type3" not in raw and b"/Subtype/Type3" not in raw, f"Type3 in {pdf}"
    assert b"/Subtype /Image" not in raw and b"/Subtype/Image" not in raw, f"Raster in {pdf}"
    print(f"[SAVED] {pdf.name} ({len(raw):,} bytes) + {png.name}")


# ---------------------------------------------------------------------------
# FIGURE 4: Dual-Axis 6-Model Null Decomposition, FSS, & Per-Date Ordering
# ---------------------------------------------------------------------------
def build_figure4() -> None:
    apply_style()
    p1 = read_panelA(R8_DIR / "table_arm1_main_panelA.csv")
    p2 = read_panelA(R8_DIR / "table_arm2_15m_panelA.csv")
    p3 = read_panelA(R8_DIR / "table_arm3_mB4_panelA.csv")
    supp = json.loads((R8_DIR / "extended_supplementary_breakdowns.json").read_text("utf-8"))

    fss_rows = list(csv.DictReader((R8_DIR / "table_finite_size_scaling.csv").open("r", encoding="utf-8")))
    fss = {}
    for r in fss_rows:
        nc = int(r["N_cut"])
        fss.setdefault(nc, {})[r["Metric"]] = {
            k: parse_pm(r[k]) for k in ("Real", "shuffled_L1", "cbb_L30", "cont_gbm", "tq_gbm", "tq_garch")
        }

    fig, axes = plt.subplots(2, 2, figsize=(10.4, 7.1), gridspec_kw={"wspace": 0.25, "hspace": 0.36})
    (ax_a, ax_b), (ax_c, ax_d) = axes

    models = ["shuffled_L1", "Real", "cbb_L30", "cont_gbm", "tq_gbm", "tq_garch"]
    m_labels = ["Shuf\n($L$=1)", "Real\nmarket", "CBB\n($L$=30)", "Cont.\nGBM", "TQ-\nGBM", "TQ-\nGARCH"]
    m_cols = [PAL["shuf"], PAL["real"], PAL["cbb"], PAL["cgbm"], PAL["tgbm"], PAL["tgarch"]]

    # --- Panel (a) ---
    x = np.arange(len(models))
    w = 0.36
    y1 = [p1["K/N retention (%)"][m][0] for m in models]
    e1 = [p1["K/N retention (%)"][m][1] for m in models]
    y2 = [p2["K/N retention (%)"][m][0] for m in models]
    e2 = [p2["K/N retention (%)"][m][1] for m in models]

    ax_a.bar(x - w / 2, y1, width=w, color=m_cols, alpha=0.92, edgecolor="#222222", lw=0.55,
             yerr=e1, capsize=2.3, error_kw={"lw": 0.75, "ecolor": "#444444"}, zorder=3)
    ax_a.bar(x + w / 2, y2, width=w, color=m_cols, alpha=0.35, edgecolor=m_cols, lw=0.95, hatch="///",
             yerr=e2, capsize=2.3, error_kw={"lw": 0.75, "ecolor": "#666666"}, zorder=3)

    for xi, v1, v2 in zip(x, y1, y2):
        ax_a.text(xi - w / 2, v1 - 3.0, r1(v1), ha="center", va="top", fontsize=6.6,
                  color="white" if xi != 3 else "#1F2933", fontweight="bold", zorder=5)
        ax_a.text(xi + w / 2, v2 + e2[int(xi)] + 0.85, r1(v2), ha="center", va="bottom",
                  fontsize=6.5, color="#333333", zorder=5)

    ax_a.annotate("", xy=(0 - w/2, 85.2), xytext=(2 - w/2, 85.2),
                  arrowprops=dict(arrowstyle="<->", color=PAL["cbb"], lw=1.0))
    ax_a.text(1 - w/2, 85.9, "+5.3 pp (1m) / +9.4 pp (15m)\nclustering relief (6/6 dates)",
              ha="center", va="bottom", fontsize=6.7, color="#007A59", fontweight="medium")
    ax_a.annotate("", xy=(1 - w/2, 91.6), xytext=(4.5, 91.6),
                  arrowprops=dict(arrowstyle="<->", color=PAL["tgbm"], lw=1.0))
    ax_a.text(2.9, 92.3, r"$-$11.2 pp fat-tail gap (GARCH $\Delta=-0.06$ pp, NS)",
              ha="center", va="bottom", fontsize=6.7, color="#005587", fontweight="medium")

    ax_a.set_xticks(x)
    ax_a.set_xticklabels(m_labels, fontsize=7.4)
    ax_a.set_ylim(48.0, 99.0)
    ax_a.set_ylabel(r"Normalized-K retention, $K/N$ (%)")
    ax_a.set_title("(a) Dual-axis bar-inclusion decomposition (1m vs. 15m)", loc="left", fontweight="bold", pad=6)
    style_ax(ax_a, "y")
    leg_a = [
        Patch(facecolor="#52606D", edgecolor="#222222", lw=0.6, alpha=0.92, label="Arm 1: 1m 48h ($N$=2,880, $n$=24)"),
        Patch(facecolor="#52606D", edgecolor="#52606D", lw=0.9, alpha=0.35, hatch="///", label="Arm 2: 15m 30d ($N$=2,880, ZR=0%)"),
    ]
    ax_a.legend(handles=leg_a, loc="lower right", frameon=True, facecolor="white", edgecolor="#D0D7DE", fontsize=6.8)

    # --- Panel (b) ---
    models_b = ["shuffled_L1", "Real", "cbb_L30", "tq_gbm", "tq_garch"]
    ml_b = ["Shuf\n($L$=1)", "Real\nmarket", "CBB\n($L$=30)", "TQ-\nGBM", "TQ-\nGARCH"]
    xb = np.arange(len(models_b))

    fk_m = [p1["F/K density (%)"][m][0] for m in models_b]
    fk_e = [p1["F/K density (%)"][m][1] for m in models_b]
    bk2_m = [p1["B/K density (%)"][m][0] for m in models_b]
    bk2_e = [p1["B/K density (%)"][m][1] for m in models_b]
    bk4_m = [p3["B/K density (%)"][m][0] for m in models_b]
    bk4_e = [p3["B/K density (%)"][m][1] for m in models_b]

    ax_b.axhspan(17.0, 18.6, color=PAL["tgbm"], alpha=0.09, zorder=1)
    ax_b.axhspan(7.1, 8.2, color=PAL["tgarch"], alpha=0.11, zorder=1)

    ax_b.errorbar(xb, fk_m, yerr=fk_e, fmt="-o", color=PAL["amber"], lw=1.6, ms=5.6, capsize=3.0,
                  markeredgecolor="white", markeredgewidth=0.6, label=r"$F/K$ density (1m, tracks clustering)", zorder=5)
    ax_b.errorbar(xb, bk2_m, yerr=bk2_e, fmt="-s", color=PAL["tgbm"], lw=1.6, ms=5.2, capsize=3.0,
                  markeredgecolor="white", markeredgewidth=0.6, label="$B/K$ invariant ($m_B=2$: 17.2\u201318.3%)", zorder=5)
    ax_b.errorbar(xb, bk4_m, yerr=bk4_e, fmt="-^", color=PAL["tgarch"], lw=1.6, ms=5.4, capsize=3.0,
                  markeredgecolor="white", markeredgewidth=0.6, label="$B/K$ invariant ($m_B=4$: 7.4\u20137.9%)", zorder=5)

    for xi, v in zip(xb, fk_m):
        ax_b.text(xi, v + fk_e[xi] + 0.95, f"{r1(v)}%", ha="center", va="bottom", fontsize=6.9, color="#A86800", fontweight="bold")
    for xi, v in zip(xb, bk2_m):
        ax_b.text(xi, v + bk2_e[xi] + 0.85, f"{r1(v)}%", ha="center", va="bottom", fontsize=6.8, color="#005587")
    for xi, v in zip(xb, bk4_m):
        ax_b.text(xi, v + bk4_e[xi] + 0.85, f"{r1(v)}%", ha="center", va="bottom", fontsize=6.8, color="#8A3F69")

    ax_b.annotate("Real $\\approx$ CBB (45.2%)\n($p_{\\mathrm{date}}=0.69$, NS)",
                  xy=(1.5, 44.8), xytext=(0.05, 32.8),
                  arrowprops=dict(arrowstyle="->", color="#52606D", lw=0.85),
                  fontsize=6.65, color="#1F2933", bbox=dict(facecolor="white", edgecolor="#D0D7DE", pad=2.2))
    ax_b.set_xticks(xb)
    ax_b.set_xticklabels(ml_b, fontsize=7.4)
    ax_b.set_ylim(3.0, 56.5)
    ax_b.set_ylabel("Structural density (%)")
    ax_b.set_title(r"(b) $F/K$ clustering sensitivity vs. $B/K$ operator invariants", loc="left", fontweight="bold", pad=6)
    style_ax(ax_b, "y")
    ax_b.legend(loc="center right", bbox_to_anchor=(0.99, 0.56), frameon=True, facecolor="white", edgecolor="#D0D7DE", fontsize=6.7)

    # --- Panel (c): Finite-Size Scaling (legend cleanly below all curves) ---
    Ns = [720, 1440, 2880]
    xc = np.arange(len(Ns))

    pz_real = [fss[n]["First-Pivot rate P(Z>=1)"]["Real"][0] * 100 for n in Ns]
    pz_tgbm = [fss[n]["First-Pivot rate P(Z>=1)"]["tq_gbm"][0] * 100 for n in Ns]
    pz_cbb  = [fss[n]["First-Pivot rate P(Z>=1)"]["cbb_L30"][0] * 100 for n in Ns]

    sl_real = [fss[n]["Window-median S lag (min)"]["Real"][0] for n in Ns]
    sl_tgbm = [fss[n]["Window-median S lag (min)"]["tq_gbm"][0] for n in Ns]
    sl_cbb  = [fss[n]["Window-median S lag (min)"]["cbb_L30"][0] for n in Ns]

    ax_c2 = ax_c.twinx()
    ax_c2.spines["top"].set_visible(False)
    ax_c2.spines["right"].set_color(PAL["shuf"])
    ax_c2.spines["right"].set_linewidth(0.7)

    l1 = ax_c.plot(xc, pz_real, "-o", color=PAL["real"], lw=1.8, ms=5.6, label=r"Real $P(Z\geq 1)$ (left)")
    l2 = ax_c.plot(xc, pz_tgbm, "--s", color=PAL["tgbm"], lw=1.35, ms=4.6, label=r"TQ-GBM $P(Z\geq 1)$ (left)")
    l3 = ax_c.plot(xc, pz_cbb, ":^", color=PAL["cbb"], lw=1.35, ms=4.8, label=r"CBB $P(Z\geq 1)$ (left)")

    l4 = ax_c2.plot(xc, sl_real, "-D", color=PAL["shuf"], lw=1.8, ms=5.2, label="Real med. $S$ lag (right)")
    l5 = ax_c2.plot(xc, sl_tgbm, "--v", color=PAL["sky"], lw=1.35, ms=4.6, label="TQ-GBM med. $S$ lag (right)")
    l6 = ax_c2.plot(xc, sl_cbb, ":P", color=PAL["amber"], lw=1.35, ms=4.8, label="CBB med. $S$ lag (right)")

    for xi, v in zip(xc, pz_real):
        dy = 2.6 if xi != 0 else 2.2
        dx = 0.0 if xi != 0 else -0.02
        ax_c.text(xi + dx, v + dy, f"{r1(v)}%", ha="center", va="bottom", fontsize=6.9, color=PAL["real"], fontweight="bold")
    ax_c2.text(0.0, sl_real[0] + 4.5, f"{r1(sl_real[0])}m", ha="center", va="bottom", fontsize=6.9, color=PAL["shuf"], fontweight="bold")
    ax_c2.text(1.06, sl_real[1] - 9.5, f"{r1(sl_real[1])}m", ha="center", va="top", fontsize=6.9, color=PAL["shuf"], fontweight="bold")
    ax_c2.text(2.0, sl_real[2] - 7.0, f"{r1(sl_real[2])}m", ha="center", va="top", fontsize=6.9, color=PAL["shuf"], fontweight="bold")

    ax_c.set_xticks(xc)
    ax_c.set_xticklabels(["720\n(12 h)", "1,440\n(24 h)", "2,880\n(48 h)"])
    ax_c.set_xlabel(r"Window length, $N$ (1-min bars)")
    ax_c.set_ylabel(r"First-Pivot rate, $P(Z\geq 1)$ (%)", color=PAL["real"])
    ax_c2.set_ylabel(r"Window-median $S$ lag (min)", color=PAL["shuf"])
    ax_c2.tick_params(axis="y", colors=PAL["shuf"], labelsize=7.8)
    ax_c.set_ylim(28, 102)
    ax_c2.set_ylim(24, 134)
    ax_c.set_xlim(-0.25, 2.25)
    ax_c.set_title("(c) Finite-size scaling & right-censoring relief", loc="left", fontweight="bold", pad=6)
    style_ax(ax_c, "y")
    lines_c = l1 + l2 + l3 + l4 + l5 + l6
    ax_c.legend(lines_c, [l.get_label() for l in lines_c], loc="lower center", ncol=2,
                frameon=True, facecolor="white", edgecolor="#D0D7DE", fontsize=6.3, columnspacing=0.8, handlelength=1.8)

    # --- Panel (d): Per-date strict ordering (clean separation from legend) ---
    drows = supp["perDateArm1"]
    xd = np.arange(len(drows))
    dlbls = [r["date"][5:] for r in drows]

    series_d = [
        ("tq_gbm_KN", "TQ-GBM", PAL["tgbm"], "--s", 4.6),
        ("tq_garch_KN", "TQ-GARCH(1,1)", PAL["tgarch"], ":^", 4.8),
        ("cbb_L30_KN", "CBB ($L$=30)", PAL["cbb"], "-.D", 4.6),
        ("Real_KN", "Real market", PAL["real"], "-o", 5.6),
        ("shuffled_L1_KN", "Shuffled ($L$=1)", PAL["shuf"], "-v", 4.8),
    ]
    for key, lbl, col, fmt, ms in series_d:
        vals = [r[key] for r in drows]
        lw = 2.0 if key == "Real_KN" else 1.35
        ax_d.plot(xd, vals, fmt, color=col, lw=lw, ms=ms, markeredgecolor="white", markeredgewidth=0.5, label=lbl, zorder=5 if key == "Real_KN" else 4)

    ax_d.fill_between(xd, [r["shuffled_L1_KN"] for r in drows], [r["cbb_L30_KN"] for r in drows],
                      color=PAL["cbb"], alpha=0.09, zorder=1)
    ax_d.text(2.5, 73.9, "6/6 dates strictly ordered:\nShuf < Real < CBB << TQ-GARCH ≈ TQ-GBM\n(exact date-clustered $p_{\\mathrm{date}} = 0.03125$)",
              ha="center", va="center", fontsize=6.8, color="#1F2933",
              bbox=dict(facecolor="white", edgecolor="#C8D0D8", lw=0.6, pad=2.8), zorder=6)

    ax_d.set_xticks(xd)
    ax_d.set_xticklabels([f"2026-\n{s}" for s in dlbls], fontsize=7.3)
    ax_d.set_xlabel("Independent 48-h calendar date (4 contracts pooled per date)")
    ax_d.set_ylabel(r"Date-mean $K/N$ retention (%)")
    ax_d.set_ylim(52.5, 82.2)
    ax_d.set_title("(d) Per-date strict ordering across 6 separated months", loc="left", fontweight="bold", pad=6)
    style_ax(ax_d, "y")
    ax_d.legend(loc="lower center", ncol=3, frameon=True, facecolor="white", edgecolor="#D0D7DE",
                fontsize=6.4, columnspacing=0.8, handlelength=1.7)

    save_vec(fig, "Figure4", "Dual-axis six-model null decomposition, finite-size scaling, and per-date consistency")


# ---------------------------------------------------------------------------
# FIGURE 5: Extended Four-Clock Look-Ahead Distortion (zero legend overlap!)
# ---------------------------------------------------------------------------
def build_figure5() -> None:
    apply_style()
    rows = list(csv.DictReader((R8_DIR / "table_four_clock_lookahead.csv").open("r", encoding="utf-8")))

    def get_series(arm, mB, layer):
        sub = [r for r in rows if r["arm"] == arm and int(r["mB"]) == mB and r["layer"] == layer]
        sub.sort(key=lambda r: int(r["h_min"]))
        hs = [int(r["h_min"]) for r in sub]
        ev = [float(r["ev_bps"]) for r in sub]
        na = [float(r["na_bps"]) for r in sub]
        em = [float(r["em_bps"]) for r in sub]
        n0 = int(sub[0]["n"])
        return hs, ev, na, em, n0

    fig, axes = plt.subplots(2, 2, figsize=(10.4, 7.1), gridspec_kw={"wspace": 0.23, "hspace": 0.42})
    (ax_a, ax_b), (ax_c, ax_d) = axes

    def plot_bs(ax, arm, mB, title, note, ylim=(-4.5, 29.0)):
        hs, ev_b, na_b, em_b, nb = get_series(arm, mB, "B")
        hs_s, ev_s, na_s, em_s, ns = get_series(arm, mB, "S")
        ax.axhline(0.0, color="#666666", lw=0.85, ls=":", zorder=2)

        ax.plot(hs, ev_b, "-o", color=PAL["event"], lw=1.8, ms=5.3, markeredgecolor="white", markeredgewidth=0.5, zorder=5)
        ax.plot(hs, na_b, "--s", color=PAL["native"], lw=1.6, ms=4.8, markeredgecolor="white", markeredgewidth=0.5, zorder=5)
        ax.plot(hs, em_b, "-^", color=PAL["emit"], lw=1.8, ms=5.3, markeredgecolor="white", markeredgewidth=0.5, zorder=6)
        ax.plot(hs_s, ev_s, "-D", color=PAL["seg_ev"], lw=1.75, ms=5.0, markeredgecolor="white", markeredgewidth=0.5, zorder=4.8)
        ax.plot(hs_s, em_s, ":v", color=PAL["seg_em"], lw=1.35, ms=4.6, zorder=4.5)

        ax.annotate(f"+{r1(ev_s[-1])}", (hs_s[-1], ev_s[-1]), xytext=(-3, 5), textcoords="offset points",
                    ha="right", va="bottom", fontsize=7.1, color=PAL["seg_ev"], fontweight="bold")
        ax.annotate(f"+{r1(ev_s[0])}", (hs_s[0], ev_s[0]), xytext=(-4, 15.0), textcoords="offset points",
                    ha="left", va="bottom", fontsize=6.8, color=PAL["seg_ev"],
                    bbox=dict(facecolor="white", edgecolor="none", alpha=0.85, pad=0.3), zorder=6.5)
        ax.annotate(f"+{r1(ev_b[-1])}", (hs[-1], ev_b[-1]), xytext=(-3, 4.5), textcoords="offset points",
                    ha="right", va="bottom", fontsize=7.0, color=PAL["event"], fontweight="bold")
        ax.annotate(f"+{r1(na_b[-1])}", (hs[-1], na_b[-1]), xytext=(-3, 3.5), textcoords="offset points",
                    ha="right", va="bottom", fontsize=6.8, color=PAL["native"])

        ax.text(0.03, 0.96, note, transform=ax.transAxes, ha="left", va="top", fontsize=6.75,
                color="#1F2933", bbox=dict(facecolor="white", edgecolor="#D0D7DE", alpha=0.96, pad=2.5), zorder=7)
        ax.set_xticks(hs)
        ax.set_xlim(2.5, 63.0)
        ax.set_ylim(*ylim)
        ax.set_xlabel("Forward horizon, $h$ (min)")
        ax.set_ylabel("Mean post-extremum reversal (bps)")
        ax.set_title(title, loc="left", fontweight="bold", pad=6)
        style_ax(ax, "y")

    plot_bs(
        ax_a, "arm1_1m_48h", 2,
        r"(a) Real markets: 1m, $m_B=2$ ($B$: 8,393; $S$: 284)",
        "Causal $t_{\\mathrm{emit}}$ ($B$): $-0.08$ to $+0.07$ bps ($p_{\\mathrm{HAC}}\\geq 0.45$)\n"
        "Median $\\Delta t_{\\mathrm{emit}}$: $B=7.0$ min (flat), $S=73.5$ min (climbing)",
        ylim=(-4.5, 29.0),
    )
    plot_bs(
        ax_b, "arm1_tq_gbm_lookahead", 2,
        r"(b) Matched TQ-GBM control ($B$: 10,010; $S$: 320)",
        "Pure random walk creates identical mechanical illusion:\n"
        "$B$: $+7.2$ bps ($t_{\\mathrm{ev}}$), $+2.9$ ($t_{\\mathrm{na}}$) $\\to 0.0$ ($t_{\\mathrm{em}}$, $p\\geq 0.37$)",
        ylim=(-4.5, 29.0),
    )
    plot_bs(
        ax_c, "arm3_mB4_1m_48h", 4,
        r"(c) Standard new-Stroke: 1m, $m_B=4$ ($B$: 3,500; $S$: 148)",
        "Longer sealing gap (9 vs. 5 min) doubles $t_{\\mathrm{native}}$ leak:\n"
        "$+5.6\\to +7.7$ bps (80.1% hit); causal $t_{\\mathrm{emit}}$ near 0",
        ylim=(-4.5, 34.5),
    )

    # Shared figure-level legend for panels (a)-(c) centered right at the top
    shared_handles = [
        Line2D([], [], color=PAL["seg_ev"], lw=1.75, marker="D", ms=5.0, label=r"Segment $S$ at $t_{\mathrm{event}}$"),
        Line2D([], [], color=PAL["seg_em"], lw=1.35, ls=":", marker="v", ms=4.6, label=r"Segment $S$ at causal $t_{\mathrm{emit}}$"),
        Line2D([], [], color=PAL["event"], lw=1.8, marker="o", ms=5.3, label=r"Stroke $B$ at $t_{\mathrm{event}}$"),
        Line2D([], [], color=PAL["native"], lw=1.6, ls="--", marker="s", ms=4.8, label=r"Stroke $B$ at $t_{\mathrm{native}}$"),
        Line2D([], [], color=PAL["emit"], lw=1.8, marker="^", ms=5.3, label=r"Stroke $B$ at causal $t_{\mathrm{emit}}$"),
    ]
    fig.legend(handles=shared_handles, loc="upper center", bbox_to_anchor=(0.5, 0.995), ncol=5,
               frameon=True, facecolor="#F8FAFC", edgecolor="#C8D0D8", fontsize=7.2,
               columnspacing=1.1, handlelength=2.0, title="Panels (a)\u2013(c) series legend", title_fontsize=7.3)

    # Panel (d): Cross-frequency 15-min (ZR = 0.00%) comparing mB=2 and mB=4 Strokes
    hs2, ev2, na2, em2, nb2 = get_series("arm2_15m_30d", 2, "B")
    hs4, ev4, na4, em4, nb4 = get_series("arm2_mB4_15m_30d", 4, "B")
    ax_d.axhline(0.0, color="#666666", lw=0.85, ls=":", zorder=2)

    ax_d.plot(hs4, ev4, "-D", color=PAL["seg_ev"], lw=1.8, ms=5.0, markeredgecolor="white", markeredgewidth=0.5,
              label=fr"$m_B=4$, $t_{{\mathrm{{ev}}}}$ ($n={nb4:,}$)", zorder=5)
    ax_d.plot(hs4, na4, "--D", color=PAL["tgarch"], lw=1.5, ms=4.6, markeredgecolor="white", markeredgewidth=0.5,
              label=r"$m_B=4$, $t_{\mathrm{na}}$", zorder=4.8)
    ax_d.plot(hs2, ev2, "-o", color=PAL["event"], lw=1.8, ms=5.0, markeredgecolor="white", markeredgewidth=0.5,
              label=fr"$m_B=2$, $t_{{\mathrm{{ev}}}}$ ($n={nb2:,}$)", zorder=5)
    ax_d.plot(hs2, na2, "--s", color=PAL["native"], lw=1.5, ms=4.6, markeredgecolor="white", markeredgewidth=0.5,
              label=r"$m_B=2$, $t_{\mathrm{na}}$", zorder=4.8)
    ax_d.plot(hs2, em2, "-^", color=PAL["emit"], lw=1.8, ms=5.0, markeredgecolor="white", markeredgewidth=0.5,
              label=r"$m_B=2$, $t_{\mathrm{em}}$", zorder=6)
    ax_d.plot(hs4, em4, ":v", color="#2B5C8F", lw=1.45, ms=4.6,
              label=r"$m_B=4$, $t_{\mathrm{em}}$", zorder=5.8)

    ax_d.annotate(f"+{r1(ev4[-1])}", (hs4[-1], ev4[-1]), xytext=(-3, 4.5), textcoords="offset points",
                  ha="right", va="bottom", fontsize=7.0, color=PAL["seg_ev"], fontweight="bold")
    ax_d.annotate(f"+{r1(na4[-1])}", (hs4[-1], na4[-1]), xytext=(-3, 4.0), textcoords="offset points",
                  ha="right", va="bottom", fontsize=6.8, color="#8A3F69")
    ax_d.annotate(f"+{r1(ev2[-1])}", (hs2[-1], ev2[-1]), xytext=(-3, -10), textcoords="offset points",
                  ha="right", va="top", fontsize=6.9, color=PAL["event"], fontweight="bold")

    ax_d.text(0.03, 0.96,
              "Zero flat bars (ZR = 0.00% across 4 contracts)\n"
              "Bar-unit invariance: $\\Delta t_{\\mathrm{em}}=7$ bars (105 m) / 10 bars (150 m)\n"
              "Causal $t_{\\mathrm{emit}}$: $p_{\\mathrm{HAC}}\\geq 0.28$ ($m_B=2$), $\\geq 0.09$ ($m_B=4$)",
              transform=ax_d.transAxes, ha="left", va="top", fontsize=6.4,
              color="#1F2933", bbox=dict(facecolor="white", edgecolor="#D0D7DE", alpha=0.96, pad=2.3), zorder=7)
    ax_d.set_xticks(hs2)
    ax_d.set_xticklabels(["15\n(1)", "30\n(2)", "60\n(4)", "120\n(8)", "240\n(16)"], fontsize=7.4)
    ax_d.set_xlim(5, 252)
    ax_d.set_ylim(-14.5, 48.0)
    ax_d.set_xlabel("Forward horizon, $h$ (min; 15-min bars in parentheses)")
    ax_d.set_ylabel("Mean post-extremum reversal (bps)")
    ax_d.set_title(r"(d) Cross-frequency 15m control ($m_B=2,4$; Layer $B$)", loc="left", fontweight="bold", pad=6)
    style_ax(ax_d, "y")
    ax_d.legend(loc="lower center", ncol=3, frameon=True, facecolor="white",
                edgecolor="#D0D7DE", fontsize=6.2, columnspacing=0.65, handlelength=1.5)

    fig.subplots_adjust(top=0.875)
    save_vec(fig, "Figure5", "Extended four-clock look-ahead distortion across 1m, TQ-GBM control, mB=4, and 15m")


# ---------------------------------------------------------------------------
# FIGURE 8: 4-Tier Scaling (Repeated vs Contiguous 10,000-Bar Real BTCUSDT)
# ---------------------------------------------------------------------------
def build_figure8() -> None:
    apply_style()
    e5x = json.loads(FIG8_E5X.read_text("utf-8"))
    ab = json.loads(EXP2_ABLATION.read_text("utf-8"))
    c_off = list(csv.DictReader((R8_DIR / "table_contiguous_scaling_hooks_off.csv").open("r", encoding="utf-8")))
    c_fast = list(csv.DictReader((R8_DIR / "table_contiguous_scaling_memoized_tail.csv").open("r", encoding="utf-8")))

    def fit_alpha(xs, ys, nmin=500):
        pts = [(x, y) for x, y in zip(xs, ys) if x >= nmin]
        return float(np.polyfit(np.log([p[0] for p in pts]), np.log([p[1] for p in pts]), 1)[0])

    xs_fa = [r["bars"] for r in e5x["scalingPoints"] if r["status"] == "COMPLETED"]
    ys_fa = [r["meanTotalRuntimeMs"] / 1000.0 for r in e5x["scalingPoints"] if r["status"] == "COMPLETED"]
    xs_nh = [r["bars"] for r in ab["scalingGrid"] if "no_step_hash" in r["modes"]]
    ys_nh = [r["modes"]["no_step_hash"]["meanTotalRuntimeSec"] for r in ab["scalingGrid"] if "no_step_hash" in r["modes"]]
    xs_ro = [r["bars"] for r in ab["scalingGrid"] if "audit_hooks_off" in r["modes"]]
    ys_ro = [r["modes"]["audit_hooks_off"]["meanTotalRuntimeSec"] for r in ab["scalingGrid"] if "audit_hooks_off" in r["modes"]]
    xs_co = [int(r["N"]) for r in c_off]
    ys_co = [float(r["elapsedSec"]) for r in c_off]
    a_co = fit_alpha(xs_co, ys_co, 500)
    xs_cf = [int(r["N"]) for r in c_fast]
    ys_cf = [float(r["elapsedSec"]) for r in c_fast]
    a_cf = fit_alpha(xs_cf, ys_cf, 500)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.4, 4.35), gridspec_kw={"width_ratios": [1.55, 1.0], "wspace": 0.24})

    ax1.set_xscale("log")
    ax1.set_yscale("log")
    ax1.axhspan(600, 8000, facecolor=PAL["crimson"], alpha=0.055, zorder=1)
    ax1.axhline(600, color=PAL["crimson"], lw=0.9, ls=(0, (4, 2.5)), alpha=0.85, zorder=2)
    ax1.text(115, 690, "600 s watchdog threshold", ha="left", va="bottom", fontsize=7.3, color=PAL["crimson"])

    ax1.plot(xs_fa, ys_fa, "-o", color=PAL["tgbm"], lw=1.75, ms=5.2, markeredgecolor="white", markeredgewidth=0.5,
             label="Full audit, repeated ($\\alpha=2.38$, $N\\leq 2$k)", zorder=5)
    ax1.scatter([5000, 10000], [600, 600], marker="^", s=46, facecolors="white", edgecolors=PAL["crimson"],
                linewidths=1.2, label="Full audit censored ($\\geq 600$ s)", zorder=6)
    ax1.plot(xs_nh, ys_nh, "--s", color=PAL["amber"], lw=1.45, ms=4.6, markeredgecolor="white", markeredgewidth=0.5,
             label="No step hash, repeated ($\\alpha=2.11$, $N\\leq 2$k)", zorder=4.5)
    ax1.plot(xs_ro, ys_ro, "-.D", color=PAL["sky"], lw=1.55, ms=4.5, markeredgecolor="white", markeredgewidth=0.5,
             label="Hooks off, repeated ($\\alpha=1.96$, 500\u20135k)", zorder=4.6)
    ax1.plot(xs_co, ys_co, "-P", color=PAL["shuf"], lw=1.85, ms=5.4, markeredgecolor="white", markeredgewidth=0.5,
             label=f"Hooks off, contiguous real ($\\alpha={a_co:.2f}$, 500\u201310k)", zorder=5.2)
    ax1.plot(xs_cf, ys_cf, "-*", color=PAL["cbb"], lw=2.0, ms=7.2, markeredgecolor="white", markeredgewidth=0.45,
             label=f"4th-tier memoized tail, real ($\\alpha={a_cf:.2f}$, 500\u201310k)", zorder=5.5)

    ax1.annotate(f"{ys_co[-1]:,.0f} s", (10000, ys_co[-1]), xytext=(-8, 5), textcoords="offset points",
                 ha="right", va="bottom", fontsize=7.4, color=PAL["shuf"], fontweight="bold")
    ax1.annotate(f"{ys_co[-2]:.0f} s", (5000, ys_co[-2]), xytext=(-8, 5), textcoords="offset points",
                 ha="right", va="bottom", fontsize=7.0, color=PAL["shuf"])
    ax1.annotate(f"{ys_ro[-1]:.1f} s", (5000, ys_ro[-1]), xytext=(6, -1), textcoords="offset points",
                 ha="left", va="center", fontsize=7.0, color="#1D70A2", fontweight="medium")
    ax1.annotate(f"{ys_cf[-1]:.1f} s", (10000, ys_cf[-1]), xytext=(4, -12), textcoords="offset points",
                 ha="center", va="top", fontsize=7.4, color="#007A59", fontweight="bold")
    ax1.annotate(f"{ys_cf[-2]:.1f} s", (5000, ys_cf[-2]), xytext=(-8, 5), textcoords="offset points",
                 ha="right", va="bottom", fontsize=7.0, color="#007A59")

    spd10k = ys_co[-1] / ys_cf[-1]
    ax1.annotate("", xy=(10000, ys_cf[-1] * 1.25), xytext=(10000, ys_co[-1] * 0.80),
                 arrowprops=dict(arrowstyle="<->", color="#333333", lw=0.95, ls=":"), zorder=4)
    ax1.text(11400, np.sqrt(ys_co[-1] * ys_cf[-1]) * 1.4, f"{spd10k:.1f}\u00d7\nbit-exact",
             ha="left", va="center", fontsize=7.3, fontweight="bold", color="#1F2933",
             bbox=dict(facecolor="white", edgecolor="#D0D7DE", alpha=0.95, pad=1.8), zorder=7)

    ax1.set_xlim(95, 22000)
    ax1.set_ylim(0.016, 8000)
    ax1.xaxis.set_major_locator(FixedLocator([120, 500, 1000, 2000, 5000, 10000]))
    ax1.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{int(x):,}"))
    ax1.xaxis.set_minor_locator(NullLocator())
    ax1.yaxis.set_major_locator(FixedLocator([0.05, 0.1, 1, 10, 100, 600, 3000]))
    ax1.yaxis.set_major_formatter(FuncFormatter(lambda y, _: f"{y:g}"))
    ax1.yaxis.set_minor_locator(NullLocator())
    ax1.set_xlabel(r"Closed bars, $N$")
    ax1.set_ylabel("Total runtime (s)")
    ax1.set_title("(a) Cumulative runtime scaling (repeated vs. contiguous real)", loc="left", fontweight="bold", pad=6)
    style_ax(ax1, "y")
    ax1.yaxis.set_major_formatter(FuncFormatter(lambda y, _: f"{y:g}"))
    ax1.legend(loc="lower right", frameon=True, facecolor="white", edgecolor="#D0D7DE", fontsize=6.35, labelspacing=0.26, handlelength=1.8)

    ax2.set_xscale("log")
    ax2.set_yscale("log")
    p50_co = [float(r["p50Ms"]) for r in c_off]
    p99_co = [float(r["p99Ms"]) for r in c_off]
    p50_cf = [float(r["p50Ms"]) for r in c_fast]
    p99_cf = [float(r["p99Ms"]) for r in c_fast]

    ax2.plot(xs_co, p99_co, "-P", color=PAL["shuf"], lw=1.65, ms=5.0, label="Hooks off: P99 (ms)")
    ax2.plot(xs_co, p50_co, "--P", color=PAL["amber"], lw=1.45, ms=4.6, label="Hooks off: P50 (ms)")
    ax2.plot(xs_cf, p99_cf, "-*", color=PAL["cbb"], lw=1.75, ms=6.6, label="4th-tier tail: P99 (ms)")
    ax2.plot(xs_cf, p50_cf, "--*", color=PAL["tgbm"], lw=1.65, ms=6.2, label="4th-tier tail: P50 (ms)")

    ax2.annotate(f"{p99_co[-1]:,.0f} ms", (10000, p99_co[-1]), xytext=(-5, 4), textcoords="offset points",
                 ha="right", va="bottom", fontsize=7.0, color=PAL["shuf"], fontweight="bold")
    ax2.annotate(f"{p99_cf[-1]:.1f} ms", (10000, p99_cf[-1]), xytext=(-5, 5), textcoords="offset points",
                 ha="right", va="bottom", fontsize=7.0, color="#007A59", fontweight="bold")
    ax2.annotate(f"O(1) median:\n{p50_cf[-1]:.2f} ms", (5000, p50_cf[-2]), xytext=(-12, 13), textcoords="offset points",
                 ha="center", va="bottom", fontsize=6.9, color="#005587", fontweight="bold",
                 arrowprops=dict(arrowstyle="->", color="#005587", lw=0.8))

    ax2.set_xlim(95, 14500)
    ax2.set_ylim(0.035, 12000)
    ax2.xaxis.set_major_locator(FixedLocator([120, 500, 1000, 2000, 5000, 10000]))
    ax2.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{int(x):,}"))
    ax2.xaxis.set_minor_locator(NullLocator())
    ax2.yaxis.set_major_locator(FixedLocator([0.1, 1, 10, 100, 1000, 5000]))
    ax2.yaxis.set_major_formatter(FuncFormatter(lambda y, _: f"{y:g}"))
    ax2.yaxis.set_minor_locator(NullLocator())
    ax2.set_xlabel(r"Closed bars, $N$ (contiguous real BTCUSDT)")
    ax2.set_ylabel("Per-bar latency (ms)")
    ax2.set_title("(b) Contiguous per-bar latency (P50 vs. P99)", loc="left", fontweight="bold", pad=6)
    style_ax(ax2, "y")
    ax2.yaxis.set_major_formatter(FuncFormatter(lambda y, _: f"{y:g}"))
    ax2.legend(loc="upper left", frameon=True, facecolor="white", edgecolor="#D0D7DE", fontsize=6.6, handlelength=1.9)

    save_vec(fig, "Figure8", "Four-tier computational scaling on repeated and contiguous 10,000-bar real BTCUSDT")


# ---------------------------------------------------------------------------
# FIGURE 6: 14-Window Correspondence Heatmap + CF-1..CF-4 Super-Additive Panel
# ---------------------------------------------------------------------------
def build_figure6() -> None:
    apply_style()
    data = json.loads(FIG6_HEATMAP.read_text("utf-8"))
    assert data["status"] == "PASS"

    W, H = 640.0, 695.0
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

    def ftext(x, y, s, size=8.4, ha="left", color=PAL["text"], weight="normal"):
        return fig.text(x / W, y / H, s, ha=ha, va="center", fontsize=size, color=color, fontweight=weight)

    def hrule(x0, x1, y, color="#B8C4CE", lw=0.5):
        fig.add_artist(Line2D([x0 / W, x1 / W], [y / H, y / H],
                              transform=fig.transFigure, color=color, lw=lw, zorder=8))

    top = 656.0
    row_h = 28.0
    gap = 8.0
    col_w = 44.0
    panel_w = 4 * col_w
    panel_left = [190.0, 386.0]
    centers = [top - (i + 0.5) * row_h - sum(i >= n for n in (5, 8, 11)) * gap for i in range(14)]
    bottom = top - 14 * row_h - 3 * gap

    for a, x_left in enumerate(panel_left):
        ftext(x_left, 679.0,
              "(a) Unique correspondence" if a == 0 else "(b) Exact correspondence",
              size=9.3, weight="bold")
        for j, col_lbl in enumerate(["K", "F", "B", r"$S^*$"]):
            ftext(x_left + (j + 0.5) * col_w, bottom - 14.0, col_lbl, size=9.0, ha="center", weight="medium")
        for i, yc in enumerate(centers):
            for j in range(4):
                panel_name = "Unique" if a == 0 else "Exact"
                r = next(v for v in data["rows"] if v["panel"] == panel_name and v["row"] == i and v["column"] == j)
                val = r["storedRate"]
                rgba = tuple(float(v) for v in cmap(norm(val)))
                black, white = (0.055, 0.10, 0.14), (1.0, 1.0, 1.0)
                tc = white if contrast(rgba, white) > contrast(rgba, black) else black
                x0 = x_left + j * col_w
                y0 = yc - row_h / 2.0
                fig.add_artist(Rectangle((x0 / W, y0 / H), col_w / W, row_h / H,
                                         transform=fig.transFigure, facecolor=rgba,
                                         edgecolor="white", lw=0.65, zorder=1))
                ftext(x0 + col_w / 2.0, yc, r["displayText"], size=8.2, ha="center", color=tc)
        fig.add_artist(Line2D([(x_left + 2 * col_w) / W] * 2, [bottom / H, top / H],
                              transform=fig.transFigure, color="white", lw=1.5, zorder=5))
        for split in (5, 8, 11):
            hrule(x_left, x_left + panel_w, (centers[split - 1] + centers[split]) / 2.0)

    for start, end in ((0, 5), (5, 8), (8, 11), (11, 14)):
        d0 = data["displayOrder"][start]
        inst = next(v["instrument"] for v in data["windows"] if v["datasetId"] == d0["datasetId"])
        ftext(14.0, (centers[start] + centers[end - 1]) / 2.0, inst, size=8.8, weight="bold")
    for i in range(14):
        r = next(v for v in data["rows"] if v["panel"] == "Unique" and v["row"] == i)
        ftext(182.0, centers[i], f"{r['dateUTC']} ({r['bars']})", size=8.0, ha="right", color=PAL["muted"])
    for split in (5, 8, 11):
        hrule(14.0, 182.0, (centers[split - 1] + centers[split]) / 2.0)

    cax = fig.add_axes([578.0 / W, bottom / H, 10.0 / W, (top - bottom) / H])
    cb = fig.colorbar(ScalarMappable(norm=norm, cmap=cmap), cax=cax, ticks=[0, 0.2, 0.4, 0.6, 0.8, 1.0])
    cb.solids.set_rasterized(False)
    cb.solids.set_edgecolor("face")
    cb.solids.set_linewidth(0.25)
    cb.ax.set_yticklabels(["0%", "20%", "40%", "60%", "80%", "100%"])
    cb.ax.tick_params(labelsize=8.0, length=2.4, width=0.55, pad=3.0)
    cb.outline.set_linewidth(0.55)
    cb.outline.set_edgecolor("#8999A6")

    # Bottom Panel (c): clean, zero-overlap super-additive counterfactuals
    ax_c = fig.add_axes([62.0 / W, 42.0 / H, 540.0 / W, 134.0 / H])
    scens = [
        "Baseline\n($m_B=2$, Var. A)",
        "CF-4b\n($m_B=2$, $G_{ext}$ off)",
        "CF-2\n(bi_strict=False)",
        "CF-3\n($m_B=4$, FX off)",
        "CF-1\n($m_B=4$, Var. A)",
        "CF-4\n($m_B=4$, $G_{ext}$ off)",
    ]
    b_vals = [30.39, 30.39, 33.98, 69.36, 83.85, 83.85]
    s_vals = [8.00, 13.04, 13.46, 10.31, 16.90, 33.71]
    xc = np.arange(len(scens))
    w = 0.36
    ax_c.bar(xc - w / 2, b_vals, width=w, color=PAL["tgbm"], edgecolor="#222222", lw=0.5, label="Stroke ($B$) micro correspondence (%)")
    ax_c.bar(xc + w / 2, s_vals, width=w, color=PAL["shuf"], edgecolor="#222222", lw=0.5, label="Partial Segment ($S^*$) micro correspondence (%)")
    for xi, bv, sv in zip(xc, b_vals, s_vals):
        ax_c.text(xi - w / 2, bv + 1.8, f"{r1(bv)}%", ha="center", va="bottom", fontsize=7.0, color="#005587", fontweight="bold")
        ax_c.text(xi + w / 2, sv + 1.8, f"{r1(sv)}%", ha="center", va="bottom", fontsize=7.0, color="#A83A00", fontweight="bold")

    ax_c.annotate("Super-additive jump:\n+5.0 pp alone vs. +16.8 pp\nafter $m_B=4$ alignment",
                  xy=(5 + w/2, 43.0), xytext=(1.42, 54.0),
                  arrowprops=dict(arrowstyle="->", color=PAL["shuf"], lw=0.95, connectionstyle="arc3,rad=-0.12"),
                  fontsize=6.9, color="#1F2933", bbox=dict(facecolor="white", edgecolor="#D0D7DE", pad=2.5))
    ax_c.set_xticks(xc)
    ax_c.set_xticklabels(scens, fontsize=7.2)
    ax_c.set_ylim(0, 106)
    ax_c.set_ylabel("Micro agreement (%)")
    ax_c.set_title("(c) 14-window counterfactual decomposition ($K=99.9\\%$, $F=99.9\\%$ invariant)", loc="left", fontweight="bold", pad=5)
    style_ax(ax_c, "y")
    ax_c.legend(loc="upper left", frameon=True, facecolor="white", edgecolor="#D0D7DE", fontsize=7.0)

    save_vec(fig, "Figure6", "14-window cross-implementation correspondence and counterfactual decomposition", tight=False)


if __name__ == "__main__":
    build_figure4()
    build_figure5()
    build_figure6()
    build_figure8()
    print("ALL 4 POLISHED VECTOR FIGURES GENERATED!")
