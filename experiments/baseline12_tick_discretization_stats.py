"""Exp 1 v22 Discretization & Correlation Diagnostics (Major 1B):
Combines baseline12_null_model_raw.json (Real, Shuffled, Continuous GBM) with
baseline12_tick_discretization.json (Real microstructure + Tick-Quantized GBM) to:
  1. Quantify exact zero-range flat-bar and adjacent equal-bound fractions per contract/window.
  2. Decompose the Real vs Continuous-GBM K/N gap into:
       (a) pure tick-size discretization (Continuous GBM -> Tick-Quantized GBM), and
       (b) residual real-market heavy-tailed range heterogeneity / off-hours flat bars (TQ-GBM -> Real).
  3. Check robustness against cross-contract same-day calendar correlation by reporting
     date-averaged (3 independent calendar dates) and symbol-averaged (4 symbols) paired comparisons.
"""
from __future__ import annotations
import json
import os
from collections import defaultdict
from pathlib import Path
import numpy as np
from scipy import stats

OUT_DIR = Path(os.environ.get("CT_RESULTS_DIR", "./results"))


def main():
    raw1 = json.loads((OUT_DIR / "baseline12_null_model_raw.json").read_text(encoding="utf-8"))
    disc = json.loads((OUT_DIR / "baseline12_tick_discretization.json").read_text(encoding="utf-8"))

    by_wm = defaultdict(list)
    for r in raw1["records"]:
        by_wm[(r["windowId"], r["model"])].append(r)

    tq_by_w = defaultdict(list)
    for r in disc["tickQuantizedGbmRecords"]:
        tq_by_w[r["windowId"]].append(r)

    real_rows = sorted(disc["realRecords"], key=lambda x: x["windowId"])
    windows = [r["windowId"] for r in real_rows]
    symbols = sorted({r["symbol"] for r in real_rows})
    months = sorted({r["month"] for r in real_rows})

    print("=== 1. Per-Symbol Microstructure & K/N Decomposition ===")
    by_sym = {}
    for sym in symbols:
        r_sub = [r for r in real_rows if r["symbol"] == sym]
        c_sub = [x for w in [r["windowId"] for r in r_sub] for x in by_wm[(w, "NULL_GBM")]]
        s_sub = [x for w in [r["windowId"] for r in r_sub] for x in by_wm[(w, "NULL_SHUFFLED")]]
        t_sub = [x for w in [r["windowId"] for r in r_sub] for x in tq_by_w[w]]
        entry = {
            "tick": r_sub[0]["tick"],
            "real_zero_range_pct": round(float(np.mean([r["zeroRangePct"] for r in r_sub])), 2),
            "real_zero_range_max_pct": round(float(np.max([r["zeroRangePct"] for r in r_sub])), 2),
            "real_eq_bound_pct": round(float(np.mean([r["equalEitherBoundAdjPct"] for r in r_sub])), 2),
            "real_raw_inc_pct": round(float(np.mean([r["rawInclusionAnyPct"] for r in r_sub])), 2),
            "tq_gbm_zero_range_pct": round(float(np.mean([r["zeroRangePct"] for r in t_sub])), 2),
            "tq_gbm_eq_bound_pct": round(float(np.mean([r["equalEitherBoundAdjPct"] for r in t_sub])), 2),
            "real_KN_pct": round(float(np.mean([r["K_over_N"] * 100 for r in r_sub])), 2),
            "shuf_KN_pct": round(float(np.mean([r["K_over_N"] * 100 for r in s_sub])), 2),
            "cont_gbm_KN_pct": round(float(np.mean([r["K_over_N"] * 100 for r in c_sub])), 2),
            "tq_gbm_KN_pct": round(float(np.mean([r["K_over_N"] * 100 for r in t_sub])), 2),
            "tq_gbm_FK_pct": round(float(np.mean([r["F_over_K"] * 100 for r in t_sub])), 2),
            "tq_gbm_BK_pct": round(float(np.mean([r["B_over_K"] * 100 for r in t_sub])), 2),
        }
        by_sym[sym] = entry
        print(
            f"  {sym:8s} (tick={entry['tick']:<4}): Real zero={entry['real_zero_range_pct']:4.2f}%, eqB={entry['real_eq_bound_pct']:5.2f}% "
            f"| TQ-GBM zero={entry['tq_gbm_zero_range_pct']:4.2f}%, eqB={entry['tq_gbm_eq_bound_pct']:5.2f}% "
            f"| K/N: Real={entry['real_KN_pct']:5.2f}%, Shuf={entry['shuf_KN_pct']:5.2f}%, TQ-GBM={entry['tq_gbm_KN_pct']:5.2f}%, Cont-GBM={entry['cont_gbm_KN_pct']:5.2f}%"
        )

    print("\n=== 2. Overall 12-Window Paired Tests (Real vs Tick-Quantized GBM vs Continuous GBM) ===")
    overall = {}
    for metric, scale in [("K_over_N", 100.0), ("F_over_K", 100.0), ("B_over_K", 100.0), ("B_over_F", 100.0), ("mean_lag_B", 1.0), ("median_lag_S", 1.0)]:
        r_vals, c_means, t_means, s_means = [], [], [], []
        for r in real_rows:
            w = r["windowId"]
            rv = r[metric]
            cv = [x[metric] * scale for x in by_wm[(w, "NULL_GBM")] if x[metric] is not None]
            tv = [x[metric] * scale for x in tq_by_w[w] if x[metric] is not None]
            sv = [x[metric] * scale for x in by_wm[(w, "NULL_SHUFFLED")] if x[metric] is not None]
            if rv is not None and len(cv) >= 5 and len(tv) >= 5:
                r_vals.append(rv * scale)
                c_means.append(float(np.mean(cv)))
                t_means.append(float(np.mean(tv)))
                s_means.append(float(np.mean(sv)))
        r_arr, c_arr, t_arr = np.array(r_vals), np.array(c_means), np.array(t_means)
        all_tq = np.array([x[metric] * scale for x in disc["tickQuantizedGbmRecords"] if x[metric] is not None])
        _, p_rt = stats.wilcoxon(r_arr, t_arr, zero_method="wilcox")
        _, p_ct = stats.wilcoxon(c_arr, t_arr, zero_method="wilcox")
        n_below_tq = int(np.sum(r_arr < t_arr))
        overall[metric] = {
            "n_windows": len(r_arr),
            "real_mean": round(float(np.mean(r_arr)), 3),
            "real_std": round(float(np.std(r_arr, ddof=1)), 3),
            "tq_gbm_mean": round(float(np.mean(all_tq)), 3),
            "tq_gbm_std": round(float(np.std(all_tq, ddof=1)), 3),
            "cont_gbm_mean_paired": round(float(np.mean(c_arr)), 3),
            "real_minus_tq_mean": round(float(np.mean(r_arr - t_arr)), 3),
            "tq_minus_cont_mean": round(float(np.mean(t_arr - c_arr)), 3),
            "p_real_vs_tq_wilcoxon": float(f"{p_rt:.4e}"),
            "p_cont_vs_tq_wilcoxon": float(f"{p_ct:.4e}"),
            "n_windows_real_below_tq": n_below_tq,
        }
        print(
            f"  {metric:14s} (n={len(r_arr):2d}): Real={np.mean(r_arr):6.2f}±{np.std(r_arr,ddof=1):5.2f} | "
            f"TQ-GBM={np.mean(all_tq):6.2f}±{np.std(all_tq,ddof=1):5.2f} | Cont-GBM={np.mean(c_arr):6.2f} | "
            f"Real<TQ: {n_below_tq}/{len(r_arr)} (p_RT={p_rt:.4e}, p_CT={p_ct:.4e})"
        )

    # Gap decomposition for K/N
    kn_real = overall["K_over_N"]["real_mean"]
    kn_tq = overall["K_over_N"]["tq_gbm_mean"]
    kn_cont = overall["K_over_N"]["cont_gbm_mean_paired"]
    total_gap = kn_cont - kn_real
    tick_share = (kn_cont - kn_tq) / total_gap * 100.0
    resid_share = (kn_tq - kn_real) / total_gap * 100.0
    print(f"\n=== 3. K/N Gap Decomposition (Cont-GBM {kn_cont:.2f}% -> TQ-GBM {kn_tq:.2f}% -> Real {kn_real:.2f}%) ===")
    print(f"  Total gap = {total_gap:.2f} pp | Pure tick-discretization share = {kn_cont - kn_tq:.2f} pp ({tick_share:.1f}%) | Residual real-market share = {kn_tq - kn_real:.2f} pp ({resid_share:.1f}%)")

    # Calendar-date (3 dates) & per-symbol (4 symbols) cross-correlation robustness
    print("\n=== 4. Calendar-Date Grouping (3 Dates: 2026-06, 2026-07, 2026-08) ===")
    by_month = {}
    for m in months:
        r_m = [r for r in real_rows if r["month"] == m]
        kn_r = float(np.mean([r["K_over_N"] * 100 for r in r_m]))
        kn_t = float(np.mean([x["K_over_N"] * 100 for r in r_m for x in tq_by_w[r["windowId"]]]))
        kn_c = float(np.mean([x["K_over_N"] * 100 for r in r_m for x in by_wm[(r["windowId"], "NULL_GBM")]]))
        fk_r = float(np.mean([r["F_over_K"] * 100 for r in r_m]))
        fk_c = float(np.mean([x["F_over_K"] * 100 for r in r_m for x in by_wm[(r["windowId"], "NULL_GBM")]]))
        bk_r = float(np.mean([r["B_over_K"] * 100 for r in r_m]))
        bk_c = float(np.mean([x["B_over_K"] * 100 for r in r_m for x in by_wm[(r["windowId"], "NULL_GBM")]]))
        by_month[m] = {
            "real_KN": round(kn_r, 2), "tq_gbm_KN": round(kn_t, 2), "cont_gbm_KN": round(kn_c, 2),
            "real_FK": round(fk_r, 2), "cont_gbm_FK": round(fk_c, 2),
            "real_BK": round(bk_r, 2), "cont_gbm_BK": round(bk_c, 2),
        }
        print(f"  {m}: K/N Real={kn_r:.2f}% < TQ-GBM={kn_t:.2f}% < Cont-GBM={kn_c:.2f}% | F/K Real={fk_r:.2f}% vs GBM={fk_c:.2f}% | B/K Real={bk_r:.2f}% vs GBM={bk_c:.2f}%")

    # Pooled real flat-bar & eq-bound stats
    pooled_real_zero = float(np.mean([r["zeroRangePct"] for r in real_rows]))
    pooled_real_eqb = float(np.mean([r["equalEitherBoundAdjPct"] for r in real_rows]))
    pooled_tq_zero = float(np.mean([r["zeroRangePct"] for r in disc["tickQuantizedGbmRecords"]]))
    pooled_tq_eqb = float(np.mean([r["equalEitherBoundAdjPct"] for r in disc["tickQuantizedGbmRecords"]]))
    print(f"\nPooled 12-window microstructure: Real zero-range={pooled_real_zero:.2f}% (eqBound={pooled_real_eqb:.2f}%) vs TQ-GBM zero-range={pooled_tq_zero:.2f}% (eqBound={pooled_tq_eqb:.2f}%)")

    summary = {
        "schemaVersion": "PhysicaA-Exp1-DiscretizationStats-v1.0",
        "pooledMicrostructure": {
            "real_zero_range_pct": round(pooled_real_zero, 2),
            "real_eq_bound_pct": round(pooled_real_eqb, 2),
            "tq_gbm_zero_range_pct": round(pooled_tq_zero, 2),
            "tq_gbm_eq_bound_pct": round(pooled_tq_eqb, 2),
        },
        "knGapDecomposition": {
            "cont_gbm_pct": kn_cont,
            "tq_gbm_pct": kn_tq,
            "real_pct": kn_real,
            "total_gap_pp": round(total_gap, 3),
            "tick_discretization_pp": round(kn_cont - kn_tq, 3),
            "tick_discretization_share_pct": round(tick_share, 1),
            "residual_real_market_pp": round(kn_tq - kn_real, 3),
            "residual_real_market_share_pct": round(resid_share, 1),
        },
        "bySymbol": by_sym,
        "byMonth": by_month,
        "overall": overall,
    }
    out_path = OUT_DIR / "baseline12_tick_discretization_stats.json"
    out_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()
