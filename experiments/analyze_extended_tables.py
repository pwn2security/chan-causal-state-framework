"""
Comprehensive R8 statistical analyzer (uses scipy + numpy from r7/.venv).
Produces machine-readable CSV & JSON tables for all R8 arms:
  - Arm 1: 6-column dual-axis main table (Panel A + Panel B with date-clustered exact Wilcoxon p_date & k/6)
  - Finite-Size Scaling (FSS) across N in {720, 1440, 2880}
  - Arm 2: 30-day 15m cross-frequency benchmark (N=2880)
  - Arm 3: mB=4 standard Chan Stroke robustness benchmark
  - CBB block-length & SBB sensitivity check
  - Extended four-clock look-ahead distortion (Arm 1 mB=2 & mB=4, Arm 2 15m, Matched TQ-GBM)
    including explicit causal-baseline zero-mean HAC test p_HAC(emit=0), non-overlapping subsamples,
    and diffusion-standardized z_h!
  - Contiguous 10,000-bar BTCUSDT scaling exponent alpha
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import stats

REPO_ROOT = Path(__file__).resolve().parent.parent
R8_ROOT = Path(os.environ.get("CT_DATA_ROOT", str(REPO_ROOT / "local_data" / "extended_validation")))
RES_DIR = Path(os.environ.get("CT_RESULTS_DIR", str(REPO_ROOT / "results")))


def exact_wilcoxon(diffs: list[float]) -> tuple[float | None, int, int, str]:
    arr = np.array([d for d in diffs if d is not None and not math.isnan(d)], dtype=float)
    n = len(arr)
    if n == 0:
        return None, 0, 0, "0/0"
    pos = int(np.sum(arr > 0))
    neg = int(np.sum(arr < 0))
    nz = arr[arr != 0]
    if len(nz) == 0:
        return 1.0, n, 0, f"0/{n}"
    try:
        m = "exact" if len(nz) <= 50 else "auto"
        res = stats.wilcoxon(nz, alternative="two-sided", method=m)
        pval = float(res.pvalue)
    except Exception:
        res = stats.wilcoxon(nz, alternative="two-sided")
        pval = float(res.pvalue)
    maj = max(pos, neg)
    sign = "+" if pos >= neg else "-"
    return pval, n, maj, f"{sign}{maj}/{n}"


def newey_west_t_test(by_window_vals: dict[str, list[float]], lag: int) -> tuple[float, float, float, int]:
    """Within-window Bartlett-kernel Newey-West HAC one-sample t-test against 0."""
    all_v = []
    for vals in by_window_vals.values():
        all_v.extend(vals)
    arr = np.array(all_v, dtype=float)
    n = len(arr)
    if n < 3:
        return float(np.mean(arr)) if n else float("nan"), float("nan"), float("nan"), n
    mu = float(np.mean(arr))
    # Sum within-window autocovariances centered around grand mean mu
    s_gamma0 = 0.0
    s_cross = 0.0
    for vals in by_window_vals.values():
        x = np.array(vals, dtype=float) - mu
        nw = len(x)
        if nw == 0:
            continue
        s_gamma0 += float(np.dot(x, x))
        for l in range(1, min(lag, nw - 1) + 1):
            w = 1.0 - l / (lag + 1.0)
            s_cross += 2.0 * w * float(np.dot(x[l:], x[:-l]))
    lrv_sum = s_gamma0 + s_cross
    # Guard against numerical non-positivity
    se2 = max(lrv_sum / (n * n), 1e-18)
    se = math.sqrt(se2)
    t_stat = mu / se
    p_val = float(2.0 * stats.t.sf(abs(t_stat), df=n - 1))
    return mu, t_stat, p_val, n


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


METRICS = [
    ("zeroRangePct", "Zero-range bars (%)", False),
    ("equalBoundPct", "Equal-bound pairs (%)", False),
    ("K_over_N", "K/N retention (%)", False),
    ("F_over_K", "F/K density (%)", False),
    ("B_over_K", "B/K density (%)", False),
    ("B_over_F", "B/F conversion (%)", False),
    ("S", "Segments S (/2,880)", False),
    ("I_Z", "First-Pivot rate P(Z>=1)", False),
    ("meanBLagMin", "Mean B native lag (min)", False),
    ("medianSLagMin", "Window-median S lag (min)", True),
]


def fmt_mean_sd(vals: list[float], dec: int = 2) -> str:
    arr = np.array([v for v in vals if v is not None and not math.isnan(v)], dtype=float)
    if len(arr) == 0:
        return "N/A"
    return f"{np.mean(arr):.{dec}f} +/- {np.std(arr, ddof=1 if len(arr) > 1 else 0):.{dec}f}"


def fmt_p(p: float | None) -> str:
    if p is None or math.isnan(p):
        return "N/A"
    if p < 1e-3:
        return f"{p:.2e}"
    return f"{p:.4f}"


def analyze_null_table(
    real_summaries: list[dict],
    null_records: list[dict],
    models: list[str],
    N_cut: int,
    label: str,
    manifest_map: dict[str, dict],
) -> tuple[list[dict], list[dict]]:
    # Real values indexed by windowId
    real_by_win = {}
    for s in real_summaries:
        snap = s["fssSnapshots"].get(str(N_cut)) or s["fssSnapshots"].get(N_cut)
        if snap:
            real_by_win[s["windowId"]] = snap

    # Null values grouped by (model, windowId) and flat list per model
    null_by_mw = defaultdict(list)
    null_flat = defaultdict(list)
    for rec in null_records:
        snap = rec["snaps"].get(str(N_cut)) or rec["snaps"].get(N_cut)
        if snap:
            null_by_mw[(rec["model"], rec["windowId"])].append(snap)
            null_flat[rec["model"]].append(snap)

    wids = sorted(real_by_win.keys())
    dates = sorted({manifest_map[w]["startDate"] for w in wids})

    panel_a = []
    panel_b = []

    print(f"\n==================== {label} (N={N_cut}, W={len(wids)}, dates={len(dates)}) ====================")
    for mkey, mlabel, pos_only in METRICS:
        row_a = {"Metric": mlabel}
        r_vals = [real_by_win[w][mkey] for w in wids if real_by_win[w][mkey] is not None]
        row_a["Real"] = fmt_mean_sd(r_vals, 3 if mkey == "I_Z" else 2)
        row_a["Real_n"] = len(r_vals)
        if pos_only and r_vals:
            row_a["Real_med_of_med"] = f"{float(np.median(r_vals)):.2f}"
        for mod in models:
            m_vals = [x[mkey] for x in null_flat[mod] if x[mkey] is not None]
            row_a[mod] = fmt_mean_sd(m_vals, 3 if mkey == "I_Z" else 2)
            row_a[f"{mod}_n"] = len(m_vals)
        panel_a.append(row_a)

        # Panel B contrasts
        contrasts = [
            ("Real_vs_tq_gbm", "REAL", "tq_gbm"),
            ("Real_vs_tq_garch", "REAL", "tq_garch"),
            ("Real_vs_shuffled_L1", "REAL", "shuffled_L1"),
            ("Real_vs_cbb_L30", "REAL", "cbb_L30"),
            ("Mech1_cbb_vs_shuf", "cbb_L30", "shuffled_L1"),
            ("Mech2_garch_vs_tqgbm", "tq_garch", "tq_gbm"),
        ]
        row_b = {"Metric": mlabel}
        for cname, A, B in contrasts:
            if (A != "REAL" and A not in models) or (B != "REAL" and B not in models):
                continue
            win_diffs = {}
            for w in wids:
                if A == "REAL":
                    vA = real_by_win[w][mkey]
                else:
                    xs = [x[mkey] for x in null_by_mw[(A, w)] if x[mkey] is not None]
                    vA = float(np.mean(xs)) if xs else None
                xsB = [x[mkey] for x in null_by_mw[(B, w)] if x[mkey] is not None]
                vB = float(np.mean(xsB)) if xsB else None
                if vA is not None and vB is not None:
                    win_diffs[w] = vA - vB
            p_win, n_win, _, s_win = exact_wilcoxon(list(win_diffs.values()))
            # Date-clustered diffs
            date_diffs = []
            for d in dates:
                d_vals = [win_diffs[w] for w in wids if manifest_map[w]["startDate"] == d and w in win_diffs]
                if d_vals:
                    date_diffs.append(float(np.mean(d_vals)))
            p_date, n_date, _, s_date = exact_wilcoxon(date_diffs)
            mean_diff = float(np.mean(list(win_diffs.values()))) if win_diffs else float("nan")
            row_b[f"{cname}_diff"] = f"{mean_diff:+.3f}" if not math.isnan(mean_diff) else "N/A"
            row_b[f"{cname}_pwin"] = fmt_p(p_win)
            row_b[f"{cname}_pdate"] = fmt_p(p_date)
            row_b[f"{cname}_kdate"] = s_date
        panel_b.append(row_b)

        # Print concise summary line
        cols_str = " | ".join(f"{mod}={row_a.get(mod,'-')}" for mod in models)
        print(f"  {mlabel:26s} | Real={row_a['Real']} | {cols_str}")
        if len(dates) >= 2:
            b_str = " | ".join(
                f"{cn}:{row_b.get(f'{cn}_diff','')} (pw={row_b.get(f'{cn}_pwin','')}, pd={row_b.get(f'{cn}_pdate','')}, {row_b.get(f'{cn}_kdate','')})"
                for cn in ["Real_vs_tq_gbm", "Real_vs_tq_garch", "Real_vs_shuffled_L1", "Real_vs_cbb_L30", "Mech1_cbb_vs_shuf", "Mech2_garch_vs_tqgbm"]
                if f"{cn}_diff" in row_b
            )
            print(f"     -> {b_str}")

    return panel_a, panel_b


def analyze_lookahead(events: list[dict]) -> list[dict]:
    print("\n==================== EXTENDED FOUR-CLOCK LOOK-AHEAD AUDIT ====================")
    groups = defaultdict(list)
    for ev in events:
        groups[(ev["arm"], ev["mB"], ev["layer"])].append(ev)

    rows = []
    for (arm, mB, layer) in sorted(groups.keys()):
        evs = groups[(arm, mB, layer)]
        if layer == "Z" and len(evs) < 4:
            continue
        is_15m = evs[0]["interval"] == "15m"
        horizons = [1, 2, 4, 8, 16] if is_15m else [5, 15, 30, 60]
        step_min = 15 if is_15m else 1

        # Pre-emission banked return
        banks = [e["bankEvEm"] for e in evs if e["bankEvEm"] is not None]
        mean_bank = float(np.mean(banks)) if banks else float("nan")
        med_em_lag = float(np.median([e["emitLagMin"] for e in evs]))
        med_na_lag = float(np.median([e["nativeLagMin"] for e in evs]))
        med_gap = float(np.median([e["gapMin"] for e in evs]))

        # Average spacing between consecutive structures in bars (for NW lag L)
        by_win_k = defaultdict(list)
        for e in evs:
            by_win_k[e["windowId"]].append(e["kEv"])
        gaps = []
        for ks in by_win_k.values():
            ks = sorted(ks)
            gaps.extend([ks[i + 1] - ks[i] for i in range(len(ks) - 1)])
        avg_spacing_bars = float(np.mean(gaps)) if gaps else 10.0

        print(f"\n--- {arm} | mB={mB} | Layer {layer} (N_total={len(evs)}, medNat={med_na_lag:.1f}m, medEmit={med_em_lag:.1f}m, medGap={med_gap:.1f}m, bank[ev,em]={mean_bank:+.2f}bps) ---")
        for h in horizons:
            hkey = str(h)
            valid = [e for e in evs if hkey in e["fwd"]]
            if len(valid) < 5:
                continue
            by_win_ev_em = defaultdict(list)
            by_win_na_em = defaultdict(list)
            by_win_em = defaultdict(list)
            by_win_z_ev = defaultdict(list)
            by_win_z_na = defaultdict(list)
            by_win_z_em = defaultdict(list)
            ev_v, na_v, em_v = [], [], []
            rv_ev, rv_na, rv_em = [], [], []

            # Sort within each window by kEv for HAC & non-overlapping subsampling
            by_win_sorted = defaultdict(list)
            for e in valid:
                by_win_sorted[e["windowId"]].append(e)
            for wid in by_win_sorted:
                by_win_sorted[wid].sort(key=lambda x: x["kEv"])

            no_ev_em, no_na_em, no_em = [], [], []
            for wid, wevs in by_win_sorted.items():
                last_end = -1
                for e in wevs:
                    f = e["fwd"][hkey]
                    ev_v.append(f["ev"]); na_v.append(f["na"]); em_v.append(f["em"])
                    rv_ev.append(f["rvEv"]); rv_na.append(f["rvNa"]); rv_em.append(f["rvEm"])
                    by_win_ev_em[wid].append(f["ev"] - f["em"])
                    by_win_na_em[wid].append(f["na"] - f["em"])
                    by_win_em[wid].append(f["em"])
                    scale = math.sqrt(h) * e["sigmaBarBps"]
                    by_win_z_ev[wid].append(f["ev"] / scale)
                    by_win_z_na[wid].append(f["na"] / scale)
                    by_win_z_em[wid].append(f["em"] / scale)
                    if e["kEv"] >= last_end:
                        no_ev_em.append(f["ev"] - f["em"])
                        no_na_em.append(f["na"] - f["em"])
                        no_em.append(f["em"])
                        last_end = e["kEm"] + h

            L = max(1, int(math.ceil(h / max(avg_spacing_bars, 1.0))))
            d_ev_em, _, p_hac_ev_em, n_use = newey_west_t_test(by_win_ev_em, L)
            d_na_em, _, p_hac_na_em, _ = newey_west_t_test(by_win_na_em, L)
            m_em_hac, t_em0, p_hac_em0, _ = newey_west_t_test(by_win_em, L)

            # Binomial test for causal emit hit rate vs 50%
            hit_ev = 100.0 * np.mean(np.array(ev_v) > 0)
            hit_na = 100.0 * np.mean(np.array(na_v) > 0)
            hit_em = 100.0 * np.mean(np.array(em_v) > 0)
            n_pos_em = int(np.sum(np.array(em_v) > 0))
            p_binom_em50 = float(stats.binomtest(n_pos_em, n_use, 0.5).pvalue)

            # Non-overlapping tests
            p_no_ev_em = exact_wilcoxon(no_ev_em)[0] if len(no_ev_em) >= 5 else None
            p_no_na_em = exact_wilcoxon(no_na_em)[0] if len(no_na_em) >= 5 else None
            p_no_em0 = exact_wilcoxon(no_em)[0] if len(no_em) >= 5 else None

            z_ev = float(np.mean([v for vs in by_win_z_ev.values() for v in vs]))
            z_na = float(np.mean([v for vs in by_win_z_na.values() for v in vs]))
            z_em = float(np.mean([v for vs in by_win_z_em.values() for v in vs]))

            row = {
                "arm": arm, "mB": mB, "layer": layer,
                "h_bars": h, "h_min": h * step_min, "n": n_use, "NW_L": L,
                "ev_bps": round(float(np.mean(ev_v)), 3),
                "na_bps": round(float(np.mean(na_v)), 3),
                "em_bps": round(float(np.mean(em_v)), 3),
                "hit_ev_pct": round(hit_ev, 2),
                "hit_na_pct": round(hit_na, 2),
                "hit_em_pct": round(hit_em, 2),
                "z_ev": round(z_ev, 3),
                "z_na": round(z_na, 3),
                "z_em": round(z_em, 3),
                "p_hac_ev_em": fmt_p(p_hac_ev_em),
                "p_hac_na_em": fmt_p(p_hac_na_em),
                "p_hac_em_eq_0": fmt_p(p_hac_em0),
                "p_binom_em_50": fmt_p(p_binom_em50),
                "n_nonov": len(no_ev_em),
                "no_d_ev_em": round(float(np.mean(no_ev_em)), 3) if no_ev_em else None,
                "p_no_ev_em": fmt_p(p_no_ev_em),
                "no_d_na_em": round(float(np.mean(no_na_em)), 3) if no_na_em else None,
                "p_no_na_em": fmt_p(p_no_na_em),
                "no_m_em": round(float(np.mean(no_em)), 3) if no_em else None,
                "p_no_em0": fmt_p(p_no_em0),
                "bank_ev_em_bps": round(mean_bank, 3) if not math.isnan(mean_bank) else None,
            }
            rows.append(row)
            print(
                f"  h={h*step_min:3d}m (n={n_use:4d}, L={L:2d}) | "
                f"ev={row['ev_bps']:+6.2f} ({row['hit_ev_pct']:5.1f}%, {z_ev:+.2f}s) | "
                f"na={row['na_bps']:+6.2f} ({row['hit_na_pct']:5.1f}%, {z_na:+.2f}s) | "
                f"em={row['em_bps']:+6.2f} ({row['hit_em_pct']:5.1f}%, {z_em:+.2f}s) | "
                f"p(ev-em)={row['p_hac_ev_em']} p(na-em)={row['p_hac_na_em']} p(em=0)={row['p_hac_em_eq_0']} | "
                f"NO(n={row['n_nonov']}): p_ev={row['p_no_ev_em']} p_na={row['p_no_na_em']} p_em0={row['p_no_em0']}"
            )
    return rows


def write_csv(path: Path, rows: list[dict]):
    if not rows:
        return
    keys = []
    for r in rows:
        for k in r.keys():
            if k not in keys:
                keys.append(k)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def main():
    global R8_ROOT, RES_DIR
    ap = argparse.ArgumentParser(description="Compute dual-axis null-model, FSS, four-clock look-ahead, and contiguous scaling tables.")
    ap.add_argument("--data-root", type=Path, default=R8_ROOT)
    ap.add_argument("--results-dir", type=Path, default=RES_DIR)
    args = ap.parse_args()
    R8_ROOT = args.data_root.resolve()
    RES_DIR = args.results_dir.resolve()

    manifest_path = R8_ROOT / "manifests" / "extended_window_manifest.json"
    if not manifest_path.exists():
        manifest_path = REPO_ROOT / "manifests" / "extended_window_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_map = {}
    for k in ["arm1_1m_48h", "arm2_15m_30d", "scaling_contiguous"]:
        for e in manifest[k]:
            manifest_map[e["windowId"]] = e

    step4_sum = json.loads((RES_DIR / "extended_real_summaries.json").read_text(encoding="utf-8"))["summaries"]
    step4_evs = json.loads((RES_DIR / "extended_real_events.json").read_text(encoding="utf-8"))["events"]

    # 1. Contiguous 10,000-bar BTCUSDT scaling analysis
    sc_rec = next((s for s in step4_sum if s["arm"] == "scaling_contiguous"), None)
    if sc_rec and sc_rec.get("timingCheckpoints"):
        print("\n==================== CONTIGUOUS 10,000-BAR BTCUSDT SCALING ====================")
        trows = []
        ns, ts = [], []
        for k in sorted(sc_rec["timingCheckpoints"].keys(), key=int):
            tc = sc_rec["timingCheckpoints"][k]
            fss = sc_rec["fssSnapshots"][k]
            row = {**tc, "K_over_N": round(fss["K_over_N"], 3), "B_over_K": round(fss["B_over_K"], 3),
                   "S": fss["S"], "S_norm_720": round(fss["S_norm_720"], 3), "medianSLagMin": fss["medianSLagMin"]}
            trows.append(row)
            if tc["N"] >= 500:
                ns.append(math.log(tc["N"]))
                ts.append(math.log(tc["elapsedSec"]))
            print(f"  N={tc['N']:5d}: elapsed={tc['elapsedSec']:7.2f}s mean={tc['meanMs']:6.2f}ms P99={tc['p99Ms']:6.2f}ms "
                  f"| K/N={fss['K_over_N']:.2f}% B/K={fss['B_over_K']:.2f}% S={fss['S']} medSLag={fss['medianSLagMin']}")
        slope, intercept, r_val, _, _ = stats.linregress(ns, ts)
        print(f"  Contiguous real stream log-log exponent alpha (N=500..10000): alpha={slope:.4f} (R^2={r_val**2:.5f})")
        write_csv(RES_DIR / "table_contiguous_scaling_hooks_off.csv", trows)

    # 2. Look-ahead audit (all arms)
    la_rows = analyze_lookahead(step4_evs)
    write_csv(RES_DIR / "table_four_clock_lookahead.csv", la_rows)

    # 3. Arm 1 main dual-axis table + FSS (if null JSONL exists)
    arm1_real = [s for s in step4_sum if s["arm"] == "arm1_1m_48h"]
    arm1_nulls = load_jsonl(RES_DIR / "nulls_arm1_mB2.jsonl")
    if arm1_nulls:
        models = ["shuffled_L1", "cbb_L30", "cont_gbm", "tq_gbm", "tq_garch"]
        pa, pb = analyze_null_table(arm1_real, arm1_nulls, models, 2880, "ARM 1 MAIN (24x48h 1m, mB=2)", manifest_map)
        write_csv(RES_DIR / "table_arm1_main_panelA.csv", pa)
        write_csv(RES_DIR / "table_arm1_main_panelB.csv", pb)
        # Finite-size scaling across N=720, 1440, 2880
        fss_rows = []
        for ncut in [720, 1440, 2880]:
            pa_n, _ = analyze_null_table(arm1_real, arm1_nulls, models, ncut, f"ARM 1 FSS N={ncut}", manifest_map)
            for r in pa_n:
                fss_rows.append({"N_cut": ncut, **r})
        write_csv(RES_DIR / "table_finite_size_scaling.csv", fss_rows)

    # 4. Arm 2 15m cross-frequency benchmark
    arm2_real = [s for s in step4_sum if s["arm"] == "arm2_15m_30d"]
    arm2_nulls = load_jsonl(RES_DIR / "nulls_arm2_15m_mB2.jsonl")
    if arm2_nulls:
        models = ["shuffled_L1", "cbb_L30", "cont_gbm", "tq_gbm", "tq_garch"]
        pa2, pb2 = analyze_null_table(arm2_real, arm2_nulls, models, 2880, "ARM 2 CROSS-FREQ (4x30d 15m, mB=2)", manifest_map)
        write_csv(RES_DIR / "table_arm2_15m_panelA.csv", pa2)
        write_csv(RES_DIR / "table_arm2_15m_panelB.csv", pb2)

    # 5. Arm 3 mB=4 robustness benchmark
    arm3_real = [s for s in step4_sum if s["arm"] == "arm3_mB4_1m_48h"]
    arm3_nulls = load_jsonl(RES_DIR / "nulls_arm3_mB4.jsonl")
    if arm3_nulls:
        models3 = ["shuffled_L1", "cbb_L30", "tq_gbm", "tq_garch"]
        pa3, pb3 = analyze_null_table(arm3_real, arm3_nulls, models3, 2880, "ARM 3 ROBUSTNESS (24x48h 1m, mB=4)", manifest_map)
        write_csv(RES_DIR / "table_arm3_mB4_panelA.csv", pa3)
        write_csv(RES_DIR / "table_arm3_mB4_panelB.csv", pb3)

    # 6. CBB block-length sensitivity
    cbb_sens = load_jsonl(RES_DIR / "nulls_cbb_sensitivity.jsonl")
    if cbb_sens:
        models_s = ["cbb_L15", "cbb_L60", "sbb_L30"]
        pas, pbs = analyze_null_table(arm1_real, cbb_sens, models_s, 2880, "CBB BLOCK-LENGTH & SBB SENSITIVITY", manifest_map)
        write_csv(RES_DIR / "table_cbb_sensitivity.csv", pas)

    print("\nANALYSIS COMPLETE!")


if __name__ == "__main__":
    main()
