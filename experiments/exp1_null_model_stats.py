"""Exp 1 (P0-1): Statistical evaluation of real 12-window R4 market dynamics vs
Shuffled-Return OHLC surrogates (Null-1) and 60-substep GBM OHLC surrogates (Null-2).
Computes pooled & per-window Monte Carlo quantiles, paired Wilcoxon signed-rank tests
(real window vs window-matched null mean), and Mann-Whitney U tests.
"""
from __future__ import annotations
import json
from collections import defaultdict
from pathlib import Path
import numpy as np
from scipy import stats

OUT_DIR = Path(r"./results")
RAW_PATH = OUT_DIR / "exp1_null_model_raw.json"

METRICS = [
    ("K_over_N", "K/N (compression)", 100.0),
    ("F_over_K", "F/K (%)", 100.0),
    ("B_over_K", "B/K (%)", 100.0),
    ("B_over_F", "B/F (%)", 100.0),
    ("S", "Confirmed Segments S (per 720 bars)", 1.0),
    ("Z", "Established Pivots Z (per 720 bars)", 1.0),
    ("median_lag_F", "Median native lag F (min)", 1.0),
    ("median_lag_B", "Median native lag B (min)", 1.0),
    ("mean_lag_B", "Mean native lag B (min)", 1.0),
    ("median_lag_S", "Median native lag S (min)", 1.0),
]

def main():
    raw = json.loads(RAW_PATH.read_text(encoding="utf-8"))
    recs = raw["records"]
    by_model = defaultdict(list)
    by_win_model = defaultdict(list)
    windows = sorted({r["windowId"] for r in recs})
    symbols = sorted({r["symbol"] for r in recs})

    for r in recs:
        by_model[r["model"]].append(r)
        by_win_model[(r["windowId"], r["model"])].append(r)

    summary = {
        "schemaVersion": "PhysicaA-Exp1-NullModelStats-v1.0",
        "windowCount": len(windows),
        "surrogatesPerWindowPerModel": raw["surrogatesPerWindowPerModel"],
        "totalNullPaths": raw["totalNullPaths"],
        "allSpotChecksExactMatch": all(x["exactMatchWithFullAudit"] for x in raw["spotChecksAgainstFullAudit"]),
        "metrics": {},
        "bySymbol": {},
    }

    print("=== Exp 1: Real Market (12 windows) vs Shuffled-Return (600) vs GBM (600) ===")
    for key, label, scale in METRICS:
        real_vals = np.array([r[key] * scale for r in by_model["REAL"] if r[key] is not None], dtype=float)
        shuf_vals = np.array([r[key] * scale for r in by_model["NULL_SHUFFLED"] if r[key] is not None], dtype=float)
        gbm_vals = np.array([r[key] * scale for r in by_model["NULL_GBM"] if r[key] is not None], dtype=float)

        # Window-matched paired comparison (12 real windows vs 12 window-specific null means)
        def compare_null(null_name):
            r_pair, n_pair, z_scores = [], [], []
            for w in windows:
                rv = by_win_model[(w, "REAL")][0][key]
                nv = [x[key] * scale for x in by_win_model[(w, null_name)] if x[key] is not None]
                if rv is not None and len(nv) >= 5:
                    rv_s = rv * scale
                    nm = float(np.mean(nv))
                    ns = float(np.std(nv, ddof=1))
                    r_pair.append(rv_s)
                    n_pair.append(nm)
                    if ns > 1e-12:
                        z_scores.append((rv_s - nm) / ns)
            r_arr, n_arr = np.array(r_pair), np.array(n_pair)
            diff = r_arr - n_arr
            w_stat, w_p = (None, None)
            if len(r_arr) >= 5 and not np.all(diff == 0):
                ws, wp = stats.wilcoxon(r_arr, n_arr, zero_method="wilcox")
                w_stat, w_p = float(ws), float(f"{wp:.4e}")
            all_null = shuf_vals if null_name == "NULL_SHUFFLED" else gbm_vals
            u_stat, u_p = stats.mannwhitneyu(real_vals, all_null, alternative="two-sided") if len(real_vals) and len(all_null) else (None, None)
            return {
                "n_windows_paired": len(r_pair),
                "null_mean": round(float(np.mean(all_null)), 4) if len(all_null) else None,
                "null_std": round(float(np.std(all_null, ddof=1)), 4) if len(all_null) > 1 else None,
                "null_q05": round(float(np.percentile(all_null, 5)), 4) if len(all_null) else None,
                "null_median": round(float(np.median(all_null)), 4) if len(all_null) else None,
                "null_q95": round(float(np.percentile(all_null, 95)), 4) if len(all_null) else None,
                "paired_mean_diff_real_minus_null": round(float(np.mean(diff)), 4) if len(diff) else None,
                "mean_within_window_z": round(float(np.mean(z_scores)), 3) if z_scores else None,
                "wilcoxon_paired_p": w_p,
                "mwu_pooled_p": float(f"{u_p:.4e}") if u_p is not None else None,
            }

        c_shuf = compare_null("NULL_SHUFFLED")
        c_gbm = compare_null("NULL_GBM")
        summary["metrics"][key] = {
            "label": label,
            "scale": scale,
            "real_n": len(real_vals),
            "real_mean": round(float(np.mean(real_vals)), 4),
            "real_std": round(float(np.std(real_vals, ddof=1)), 4) if len(real_vals) > 1 else 0.0,
            "real_median": round(float(np.median(real_vals)), 4),
            "real_min": round(float(np.min(real_vals)), 4),
            "real_max": round(float(np.max(real_vals)), 4),
            "vs_shuffled": c_shuf,
            "vs_gbm": c_gbm,
        }
        print(
            f"  {label:35s} | REAL={np.mean(real_vals):6.2f}±{np.std(real_vals,ddof=1):5.2f} "
            f"| SHUF={c_shuf['null_mean']:6.2f}±{c_shuf['null_std']:5.2f} (pW={c_shuf['wilcoxon_paired_p']}, z={c_shuf['mean_within_window_z']}) "
            f"| GBM={c_gbm['null_mean']:6.2f}±{c_gbm['null_std']:5.2f} (pW={c_gbm['wilcoxon_paired_p']}, z={c_gbm['mean_within_window_z']})"
        )

    # Also summarize per symbol for K/N, F/K, B/K, S, Z
    for sym in symbols:
        summary["bySymbol"][sym] = {}
        for mod in ["REAL", "NULL_SHUFFLED", "NULL_GBM"]:
            sub = [r for r in by_model[mod] if r["symbol"] == sym]
            summary["bySymbol"][sym][mod] = {
                "n": len(sub),
                "K_over_N_pct": round(float(np.mean([r["K_over_N"] * 100 for r in sub])), 2),
                "F_over_K_pct": round(float(np.mean([r["F_over_K"] * 100 for r in sub])), 2),
                "B_over_K_pct": round(float(np.mean([r["B_over_K"] * 100 for r in sub])), 2),
                "S_mean": round(float(np.mean([r["S"] for r in sub])), 2),
                "Z_mean": round(float(np.mean([r["Z"] for r in sub])), 2),
                "Z_total": int(sum(r["Z"] for r in sub)),
            }

    out_path = OUT_DIR / "exp1_null_model_stats.json"
    out_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"\nSaved: {out_path}")

if __name__ == "__main__":
    main()
