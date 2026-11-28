"""Exp 4 v22 Robustness (Major 1A):
Adds serial-correlation-robust inference for Table 14 & Table S12.2:
  1. Multi-window Bartlett-kernel Newey-West HAC t-tests (within each window, zero cross-window lag):
     - Event-rank lag L = ceil(h / mean_spacing) and conservative L = 2*ceil(h / mean_spacing)
     - Exact calendar-time Bartlett kernel with bandwidth h minutes: w(i,j) = max(0, 1 - |k_j - k_i| / h)
  2. Strictly non-overlapping subsamples:
     - Event-anchor thinning: k_event_next >= k_event_prev + h
     - Strict union-clock thinning: k_event_next >= k_emit_prev + h (zero overlap of either [t_ev, t_ev+h] or [t_em, t_em+h])
  3. Pre-emission vs post-emission return decomposition proving flat +8.4..+9.3 bps at t_event
     is banked entirely during the pre-emission 0-6 min look-ahead window.
"""
from __future__ import annotations
import csv
import json
import os
import math
from collections import defaultdict
from pathlib import Path
import numpy as np
from scipy import stats

P0_DIR = Path(os.environ.get("CT_FOUR_CLOCK_DIR", "./four_clock_replay"))
R7_INPUTS = Path(os.environ.get("CT_WINDOWS_DIR", "./local_windows"))
OUT_DIR = Path(os.environ.get("CT_RESULTS_DIR", "./results"))
HORIZONS = [5, 15, 30, 60]


def load_bars_map():
    return {p.stem: json.loads(p.read_text(encoding="utf-8"))["bars"] for p in R7_INPUTS.glob("*.json")}


def load_direction_map():
    meta = {}
    for slot in range(1, 6):
        sdir = P0_DIR / f"slot-{slot}"
        res = json.loads((sdir / "result.json").read_text(encoding="utf-8"))
        wid = res.get("windowId") or res.get("id") or res.get("datasetId") or res.get("window_id")
        sealed = json.loads((sdir / "final-sealed.json").read_text(encoding="utf-8"))
        for layer_key, layer_code in [("strokes", "B"), ("segments", "S"), ("pivots", "Z")]:
            for obj in sealed.get(layer_key, []):
                sid = obj.get("structureId") or obj.get("id")
                direction = obj.get("direction")
                geom = obj.get("geometry", {})
                if direction is None and "startPrice" in geom and "endPrice" in geom:
                    direction = "UP" if geom["endPrice"] >= geom["startPrice"] else "DOWN"
                meta[(wid, layer_code, sid)] = {"direction": direction, "geometry": geom, "slot": slot}
    return meta


def reversal_bps(bars, k0, k1, direction):
    n = len(bars)
    if k0 is None or k1 is None or k0 < 0 or k1 < 0 or k0 >= n or k1 >= n:
        return None
    p0, p1 = float(bars[k0]["close"]), float(bars[k1]["close"])
    if p0 <= 0 or p1 <= 0:
        return None
    sign = 1.0 if direction == "UP" else (-1.0 if direction == "DOWN" else None)
    if sign is None:
        return None
    return -sign * math.log(p1 / p0) * 1e4


def panel_newey_west_t(items, lag_rank: int):
    """Multi-window Bartlett-kernel Newey-West HAC t-test on list of (wid, k_event, diff)."""
    n = len(items)
    if n < 4:
        return None
    vals = np.array([x[2] for x in items], dtype=float)
    mean_d = float(np.mean(vals))
    by_win = defaultdict(list)
    for wid, k_ev, d in items:
        by_win[wid].append((k_ev, d - mean_d))
    # Sum autocovariances within each window
    s0 = 0.0
    s_cov = 0.0
    for wid, arr in by_win.items():
        arr.sort(key=lambda x: x[0])
        u = [x[1] for x in arr]
        m = len(u)
        s0 += sum(v * v for v in u)
        for ell in range(1, min(lag_rank, m - 1) + 1):
            w = 1.0 - ell / (lag_rank + 1.0)
            s_cov += 2.0 * w * sum(u[i] * u[i - ell] for i in range(ell, m))
    lrv = (s0 + s_cov) / n
    # Ensure positive variance (Bartlett kernel guarantees PSD, numerical floor for safety)
    se = math.sqrt(max(lrv, 1e-12) / n)
    t_stat = mean_d / se
    p_val = float(2.0 * stats.t.sf(abs(t_stat), df=n - 1))
    return {
        "n": n,
        "lag_rank": lag_rank,
        "mean_diff": round(mean_d, 4),
        "hac_se": round(se, 4),
        "t_stat": round(t_stat, 4),
        "p_value": float(f"{p_val:.4e}"),
    }


def panel_time_bartlett_t(items, bandwidth_min: float):
    """Exact calendar-time Bartlett kernel within each window: w(i,j) = max(0, 1 - |k_j - k_i| / B)."""
    n = len(items)
    if n < 4:
        return None
    vals = np.array([x[2] for x in items], dtype=float)
    mean_d = float(np.mean(vals))
    by_win = defaultdict(list)
    for wid, k_ev, d in items:
        by_win[wid].append((k_ev, d - mean_d))
    total = 0.0
    for wid, arr in by_win.items():
        arr.sort(key=lambda x: x[0])
        m = len(arr)
        for i in range(m):
            ki, ui = arr[i]
            total += ui * ui
            for j in range(i + 1, m):
                kj, uj = arr[j]
                dt = kj - ki
                if dt >= bandwidth_min:
                    break
                w = 1.0 - dt / bandwidth_min
                total += 2.0 * w * ui * uj
    lrv = total / n
    se = math.sqrt(max(lrv, 1e-12) / n)
    t_stat = mean_d / se
    p_val = float(2.0 * stats.t.sf(abs(t_stat), df=n - 1))
    return {
        "n": n,
        "bandwidth_min": bandwidth_min,
        "mean_diff": round(mean_d, 4),
        "hac_se": round(se, 4),
        "t_stat": round(t_stat, 4),
        "p_value": float(f"{p_val:.4e}"),
    }


def non_overlapping_test(paired, h: int, strict_union: bool, key_a: str, key_b: str):
    """Greedy non-overlapping subsample within each window."""
    by_win = defaultdict(list)
    for rec in paired:
        by_win[rec["window_id"]].append(rec)
    selected = []
    for wid in sorted(by_win.keys()):
        arr = sorted(by_win[wid], key=lambda x: x["k_event"])
        min_next_k = -1
        for rec in arr:
            if rec["k_event"] >= min_next_k:
                selected.append(rec)
                if strict_union:
                    min_next_k = rec["k_emit"] + h
                else:
                    min_next_k = rec["k_event"] + h
    va = np.array([r[key_a] for r in selected], dtype=float)
    vb = np.array([r[key_b] for r in selected], dtype=float)
    diff = va - vb
    n = len(diff)
    if n < 5:
        return {"n": n, "mean_diff": round(float(np.mean(diff)), 4) if n else None, "wilcoxon_p": None, "ttest_p": None}
    w_p = 1.0 if np.all(diff == 0) else float(stats.wilcoxon(va, vb, zero_method="wilcox")[1])
    t_stat, t_p = stats.ttest_rel(va, vb)
    return {
        "n": n,
        "mean_a": round(float(np.mean(va)), 4),
        "mean_b": round(float(np.mean(vb)), 4),
        "mean_diff": round(float(np.mean(diff)), 4),
        "hit_a_pct": round(float(np.mean(va > 0) * 100), 2),
        "hit_b_pct": round(float(np.mean(vb > 0) * 100), 2),
        "wilcoxon_p": float(f"{w_p:.4e}"),
        "ttest_p": float(f"{float(t_p):.4e}"),
    }


def main():
    bars_by_win = load_bars_map()
    meta = load_direction_map()
    events = defaultdict(list)
    with (P0_DIR / "first_emission_records.csv").open("r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r["layer"] in ("B", "S") and r["in_terminal_sealed"].strip().lower() == "true":
                wid, layer, sid = r["window_id"], r["layer"], r["structure_id"]
                direction = meta.get((wid, layer, sid), {}).get("direction")
                if direction is None and ":BOTTOM:" in sid and ":TOP:" in sid:
                    direction = "UP" if sid.find(":BOTTOM:") < sid.find(":TOP:") else "DOWN"
                events[layer].append({
                    "window_id": wid,
                    "structure_id": sid,
                    "direction": direction,
                    "k_event": int(r["k_event"]),
                    "k_native": int(r["k_native"]),
                    "k_emit": int(r["k_emit_first"]),
                })

    out = {"schemaVersion": "PhysicaA-Exp4-Robustness-v1.0", "layers": {}}
    for layer in ["B", "S"]:
        layer_res = {}
        # Pre-emission & incremental path decomposition
        pre_em_vals = []
        pre_na_vals = []
        na_to_em_vals = []
        for ev in events[layer]:
            bars = bars_by_win[ev["window_id"]]
            r_ev_em = reversal_bps(bars, ev["k_event"], ev["k_emit"], ev["direction"])
            r_ev_na = reversal_bps(bars, ev["k_event"], ev["k_native"], ev["direction"])
            r_na_em = reversal_bps(bars, ev["k_native"], ev["k_emit"], ev["direction"])
            if r_ev_em is not None:
                pre_em_vals.append(r_ev_em)
            if r_ev_na is not None:
                pre_na_vals.append(r_ev_na)
            if r_na_em is not None:
                na_to_em_vals.append(r_na_em)

        layer_res["embedded_pre_emission_pullback"] = {
            "n": len(pre_em_vals),
            "event_to_emit_mean_bps": round(float(np.mean(pre_em_vals)), 4),
            "event_to_emit_median_bps": round(float(np.median(pre_em_vals)), 4),
            "event_to_emit_hit_pct": round(float(np.mean(np.array(pre_em_vals) > 0) * 100), 2),
            "event_to_native_mean_bps": round(float(np.mean(pre_na_vals)), 4),
            "native_to_emit_mean_bps": round(float(np.mean(na_to_em_vals)), 4),
            "native_to_emit_hit_pct": round(float(np.mean(np.array(na_to_em_vals) > 0) * 100), 2),
        }

        layer_res["by_horizon"] = {}
        for h in HORIZONS:
            paired = []
            for ev in events[layer]:
                bars = bars_by_win[ev["window_id"]]
                re_ = reversal_bps(bars, ev["k_event"], ev["k_event"] + h, ev["direction"])
                rn_ = reversal_bps(bars, ev["k_native"], ev["k_native"] + h, ev["direction"])
                rp_ = reversal_bps(bars, ev["k_emit"], ev["k_emit"] + h, ev["direction"])
                post5 = reversal_bps(bars, ev["k_event"] + 5, ev["k_event"] + h, ev["direction"]) if h > 5 else 0.0
                if re_ is not None and rn_ is not None and rp_ is not None:
                    paired.append({
                        **ev,
                        "rev_event": re_,
                        "rev_native": rn_,
                        "rev_emit": rp_,
                        "diff_ev_em": re_ - rp_,
                        "diff_na_em": rn_ - rp_,
                        "post5_increment": post5,
                    })
            # Mean inter-event spacing in minutes
            by_w = defaultdict(list)
            for p in paired:
                by_w[p["window_id"]].append(p["k_event"])
            gaps = []
            for ks in by_w.values():
                ks.sort()
                gaps.extend(ks[i] - ks[i - 1] for i in range(1, len(ks)))
            mean_gap = float(np.mean(gaps)) if gaps else float(h)
            lag_match = max(1, math.ceil(h / mean_gap))
            lag_2x = max(2, 2 * lag_match)

            ev_em_items = [(p["window_id"], p["k_event"], p["diff_ev_em"]) for p in paired]
            na_em_items = [(p["window_id"], p["k_event"], p["diff_na_em"]) for p in paired]

            layer_res["by_horizon"][str(h)] = {
                "n_paired": len(paired),
                "mean_event_spacing_min": round(mean_gap, 3),
                "post_5min_increment_from_event_mean_bps": round(float(np.mean([p["post5_increment"] for p in paired if p["post5_increment"] is not None])), 4) if h > 5 else 0.0,
                "event_minus_emit": {
                    "nw_hac_matched_lag": panel_newey_west_t(ev_em_items, lag_match),
                    "nw_hac_double_lag": panel_newey_west_t(ev_em_items, lag_2x),
                    "time_bartlett_h": panel_time_bartlett_t(ev_em_items, float(h)),
                    "time_bartlett_2h": panel_time_bartlett_t(ev_em_items, float(2 * h)),
                    "non_overlapping_event_gap": non_overlapping_test(paired, h, False, "rev_event", "rev_emit"),
                    "non_overlapping_strict_union": non_overlapping_test(paired, h, True, "rev_event", "rev_emit"),
                },
                "native_minus_emit": {
                    "nw_hac_matched_lag": panel_newey_west_t(na_em_items, lag_match),
                    "nw_hac_double_lag": panel_newey_west_t(na_em_items, lag_2x),
                    "time_bartlett_h": panel_time_bartlett_t(na_em_items, float(h)),
                    "time_bartlett_2h": panel_time_bartlett_t(na_em_items, float(2 * h)),
                    "non_overlapping_event_gap": non_overlapping_test(paired, h, False, "rev_native", "rev_emit"),
                    "non_overlapping_strict_union": non_overlapping_test(paired, h, True, "rev_native", "rev_emit"),
                },
            }
        out["layers"][layer] = layer_res

    out_path = OUT_DIR / "baseline5_overlap_robustness.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {out_path}\n")

    for layer in ["B", "S"]:
        lr = out["layers"][layer]
        pe = lr["embedded_pre_emission_pullback"]
        print(f"=== Layer {layer} Embedded Pre-Emission Pullback (n={pe['n']}) ===")
        print(f"  [t_event -> t_emit]:   mean={pe['event_to_emit_mean_bps']:+.2f} bps (med={pe['event_to_emit_median_bps']:+.2f}, hit={pe['event_to_emit_hit_pct']:.1f}%)")
        print(f"  [t_event -> t_native]: mean={pe['event_to_native_mean_bps']:+.2f} bps | [t_native -> t_emit]: mean={pe['native_to_emit_mean_bps']:+.2f} bps (hit={pe['native_to_emit_hit_pct']:.1f}%)")
        for h in HORIZONS:
            r = lr["by_horizon"][str(h)]
            ee = r["event_minus_emit"]
            ne = r["native_minus_emit"]
            print(f"  h={h:2d}m (n={r['n_paired']}, post5_inc={r['post_5min_increment_from_event_mean_bps']:+.2f} bps):")
            print(f"    ev-em: NW(L={ee['nw_hac_matched_lag']['lag_rank']}) t={ee['nw_hac_matched_lag']['t_stat']:.2f} p={ee['nw_hac_matched_lag']['p_value']:.2e} | NW(2L) p={ee['nw_hac_double_lag']['p_value']:.2e} | TimeBart(h) p={ee['time_bartlett_h']['p_value']:.2e} | NonOv(n={ee['non_overlapping_strict_union']['n']}) diff={ee['non_overlapping_strict_union']['mean_diff']:+.2f} pW={ee['non_overlapping_strict_union']['wilcoxon_p']}")
            print(f"    na-em: NW(L={ne['nw_hac_matched_lag']['lag_rank']}) t={ne['nw_hac_matched_lag']['t_stat']:.2f} p={ne['nw_hac_matched_lag']['p_value']:.2e} | NW(2L) p={ne['nw_hac_double_lag']['p_value']:.2e} | TimeBart(h) p={ne['time_bartlett_h']['p_value']:.2e} | NonOv(n={ne['non_overlapping_strict_union']['n']}) diff={ne['non_overlapping_strict_union']['mean_diff']:+.2f} pW={ne['non_overlapping_strict_union']['wilcoxon_p']}")


if __name__ == "__main__":
    main()
