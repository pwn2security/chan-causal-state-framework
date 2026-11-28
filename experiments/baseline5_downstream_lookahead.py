"""Exp 4 (P1-6): Downstream look-ahead distortion across structural clocks (t_event, t_native, t_emit).

Strictly read-only diagnostic over the frozen 5-window four-clock replay artifacts and
frozen closed 1-minute OHLC bars. No trading profitability claim; quantifies conditional
directional continuation and realized volatility distortion caused by backdating anchors.
"""
from __future__ import annotations
import csv
import json
import math
import os
from collections import defaultdict
from pathlib import Path
import numpy as np
from scipy import stats

P0_DIR = Path(os.environ.get("CT_FOUR_CLOCK_DIR", "./four_clock_replay"))
R7_INPUTS = Path(os.environ.get("CT_WINDOWS_DIR", "./local_windows"))
OUT_DIR = Path(os.environ.get("CT_RESULTS_DIR", "./results"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

HORIZONS = [5, 15, 30, 60]

def load_bars_map():
    bars_by_win = {}
    for p in R7_INPUTS.glob("*.json"):
        d = json.loads(p.read_text(encoding="utf-8"))
        bars_by_win[p.stem] = d["bars"]
    return bars_by_win

def load_direction_map():
    # Extract direction & geometry for every B, S, Z from slot-1..5/final-sealed.json
    meta = {}
    for slot in range(1, 6):
        sdir = P0_DIR / f"slot-{slot}"
        res = json.loads((sdir / "result.json").read_text(encoding="utf-8"))
        wid = res.get("windowId") or res.get("id") or res.get("datasetId") or res.get("window_id")
        sealed = json.loads((sdir / "final-sealed.json").read_text(encoding="utf-8"))
        # Inspect keys
        for layer_key, layer_code in [("strokes", "B"), ("segments", "S"), ("pivots", "Z")]:
            for obj in sealed.get(layer_key, []):
                sid = obj.get("structureId") or obj.get("id")
                direction = obj.get("direction")
                geom = obj.get("geometry", {})
                if direction is None and "startPrice" in geom and "endPrice" in geom:
                    direction = "UP" if geom["endPrice"] >= geom["startPrice"] else "DOWN"
                meta[(wid, layer_code, sid)] = {
                    "direction": direction,
                    "geometry": geom,
                    "slot": slot,
                }
    return meta

def compute_forward_metrics(bars, k_anchor, horizon, direction):
    """Given 0-based raw bar index k_anchor, evaluate forward [k_anchor -> k_anchor + horizon]
    using closed bar closes (and 1-min log returns inside (k_anchor, k_anchor + horizon]).
    Returns None if out of window bounds.
    """
    n = len(bars)
    if k_anchor is None or k_anchor < 0 or k_anchor + horizon >= n:
        return None
    p0 = float(bars[k_anchor]["close"])
    ph = float(bars[k_anchor + horizon]["close"])
    if p0 <= 0 or ph <= 0:
        return None
    cum_ret = math.log(ph / p0) * 1e4  # basis points (bps)
    # 1-minute log returns inside (k_anchor, k_anchor + horizon]
    step_rets = []
    for i in range(k_anchor + 1, k_anchor + horizon + 1):
        c_prev = float(bars[i - 1]["close"])
        c_cur = float(bars[i]["close"])
        step_rets.append(math.log(c_cur / c_prev) * 1e4)
    rv = math.sqrt(sum(r * r for r in step_rets))  # realized vol over h mins in bps
    sign = 1.0 if direction == "UP" else (-1.0 if direction == "DOWN" else None)
    # Note: for an UP Stroke/Segment ending at a TOP extremum, continuation means post-top reversal (-sign)
    # vs post-end trend continuation (+sign). We report BOTH:
    #   (a) reversal_ret_bps = -sign * cum_ret  (since a completed UP structure peaks at k_event,
    #       retrospective anchoring at k_event captures the mechanical pullback that confirmed it!)
    #   (b) abs_ret_bps = |cum_ret|
    #   (c) rv_bps = sqrt(sum r_i^2)
    rev_ret = (-sign * cum_ret) if sign is not None else None
    rev_hit = (1.0 if rev_ret > 0 else 0.0) if rev_ret is not None else None
    return {
        "cum_ret_bps": cum_ret,
        "abs_ret_bps": abs(cum_ret),
        "rv_bps": rv,
        "post_peak_reversal_bps": rev_ret,
        "post_peak_reversal_hit": rev_hit,
    }

def main():
    bars_by_win = load_bars_map()
    meta = load_direction_map()
    print(f"Loaded bars for {len(bars_by_win)} windows; direction metadata for {len(meta)} B/S/Z structures.")

    # Load first_emission_records.csv (UTF-8 with BOM)
    rows = []
    with (P0_DIR / "first_emission_records.csv").open("r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r["layer"] in ("B", "S", "Z") and r["in_terminal_sealed"].strip().lower() == "true":
                rows.append(r)

    # Also cross-check sz_four_clock_table.json for S and Z exact k_guard_eligible
    sz_table = json.loads((P0_DIR / "sz_four_clock_table.json").read_text(encoding="utf-8"))
    sz_guard = {(x["window_id"], x["structure_id"]): x for x in sz_table}

    # Build unified event list for B (terminal sealed), S, Z
    events = defaultdict(list)
    missing_dir = 0
    for r in rows:
        wid = r["window_id"]
        layer = r["layer"]
        sid = r["structure_id"]
        m = meta.get((wid, layer, sid), {})
        direction = m.get("direction")
        if direction is None and layer in ("B", "S"):
            # Fallback parse from structure_id if needed
            if ":BOTTOM:" in sid and ":TOP:" in sid:
                direction = "UP" if sid.find(":BOTTOM:") < sid.find(":TOP:") else "DOWN"
            else:
                missing_dir += 1
        k_event = int(r["k_event"])
        k_native = int(r["k_native"])
        k_emit = int(r["k_emit_first"])
        k_guard = sz_guard[(wid, sid)]["k_guard_eligible"] if (wid, sid) in sz_guard else None
        events[layer].append({
            "window_id": wid,
            "layer": layer,
            "structure_id": sid,
            "direction": direction,
            "k_event": k_event,
            "k_native": k_native,
            "k_guard": k_guard,
            "k_emit": k_emit,
            "native_lag": k_native - k_event,
            "emit_lag": k_emit - k_event,
            "emit_minus_native": k_emit - k_native,
        })

    print("Terminal sealed event counts:", {k: len(v) for k, v in events.items()}, "missing_dir:", missing_dir)

    summary = {"horizons_min": HORIZONS, "layers": {}}
    for layer in ["B", "S", "Z"]:
        layer_out = {"total_events": len(events[layer]), "by_horizon": {}}
        for h in HORIZONS:
            # Paired comparison: restrict to events where ALL THREE clocks (event, native, emit) have valid +h horizon!
            paired = []
            for ev in events[layer]:
                bars = bars_by_win[ev["window_id"]]
                me = compute_forward_metrics(bars, ev["k_event"], h, ev["direction"])
                mn = compute_forward_metrics(bars, ev["k_native"], h, ev["direction"])
                mp = compute_forward_metrics(bars, ev["k_emit"], h, ev["direction"])
                if me is not None and mn is not None and mp is not None:
                    paired.append((ev, me, mn, mp))

            n = len(paired)
            if n == 0:
                layer_out["by_horizon"][str(h)] = {"n_paired": 0}
                continue

            def agg(idx, field):
                vals = [p[idx][field] for p in paired if p[idx][field] is not None]
                if not vals:
                    return None
                arr = np.array(vals, dtype=float)
                return {
                    "n": len(vals),
                    "mean": round(float(np.mean(arr)), 4),
                    "median": round(float(np.median(arr)), 4),
                    "std": round(float(np.std(arr, ddof=1)), 4) if len(vals) > 1 else 0.0,
                }

            def paired_test(idx_a, idx_b, field):
                va = [p[idx_a][field] for p in paired if p[idx_a][field] is not None and p[idx_b][field] is not None]
                vb = [p[idx_b][field] for p in paired if p[idx_a][field] is not None and p[idx_b][field] is not None]
                if len(va) < 3:
                    return None
                diff = np.array(va) - np.array(vb)
                if np.all(diff == 0):
                    return {"n": len(va), "mean_diff": 0.0, "median_diff": 0.0, "wilcoxon_p": 1.0}
                stat, pval = stats.wilcoxon(va, vb, zero_method="wilcox")
                return {
                    "n": len(va),
                    "mean_diff": round(float(np.mean(diff)), 4),
                    "median_diff": round(float(np.median(diff)), 4),
                    "wilcoxon_stat": round(float(stat), 4),
                    "wilcoxon_p": float(f"{pval:.4e}"),
                }

            rec = {
                "n_paired": n,
                "mean_native_lag_min": round(float(np.mean([p[0]["native_lag"] for p in paired])), 3),
                "mean_emit_lag_min": round(float(np.mean([p[0]["emit_lag"] for p in paired])), 3),
                "mean_emit_minus_native_min": round(float(np.mean([p[0]["emit_minus_native"] for p in paired])), 3),
                "metrics": {},
                "paired_diffs": {},
            }
            for field in ["post_peak_reversal_bps", "post_peak_reversal_hit", "abs_ret_bps", "rv_bps"]:
                rec["metrics"][field] = {
                    "t_event": agg(1, field),
                    "t_native": agg(2, field),
                    "t_emit": agg(3, field),
                }
                rec["paired_diffs"][field] = {
                    "event_minus_emit": paired_test(1, 3, field),
                    "native_minus_emit": paired_test(2, 3, field),
                    "event_minus_native": paired_test(1, 2, field),
                }
            layer_out["by_horizon"][str(h)] = rec
        summary["layers"][layer] = layer_out

    out_path = OUT_DIR / "baseline5_downstream_lookahead.json"
    out_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"\nSaved: {out_path}\n")

    # Pretty summary table
    for layer in ["B", "S", "Z"]:
        print(f"=== Layer {layer} (total sealed={summary['layers'][layer]['total_events']}) ===")
        for h in HORIZONS:
            r = summary["layers"][layer]["by_horizon"][str(h)]
            if r["n_paired"] == 0:
                continue
            m = r["metrics"]
            d = r["paired_diffs"]
            if layer in ("B", "S"):
                rev_e = m["post_peak_reversal_bps"]["t_event"]["mean"]
                rev_n = m["post_peak_reversal_bps"]["t_native"]["mean"]
                rev_p = m["post_peak_reversal_bps"]["t_emit"]["mean"]
                hit_e = m["post_peak_reversal_hit"]["t_event"]["mean"] * 100
                hit_n = m["post_peak_reversal_hit"]["t_native"]["mean"] * 100
                hit_p = m["post_peak_reversal_hit"]["t_emit"]["mean"] * 100
                p_ep = d["post_peak_reversal_bps"]["event_minus_emit"]["wilcoxon_p"] if d["post_peak_reversal_bps"]["event_minus_emit"] else None
                p_np = d["post_peak_reversal_bps"]["native_minus_emit"]["wilcoxon_p"] if d["post_peak_reversal_bps"]["native_minus_emit"] else None
                rv_e = m["rv_bps"]["t_event"]["mean"]
                rv_n = m["rv_bps"]["t_native"]["mean"]
                rv_p = m["rv_bps"]["t_emit"]["mean"]
                print(f"  h={h:2d}m (n={r['n_paired']:3d}): Reversal(bps) event={rev_e:+6.2f}, native={rev_n:+6.2f}, emit={rev_p:+6.2f} [p_ev-em={p_ep}, p_na-em={p_np}] | Hit% ev={hit_e:5.1f}%, na={hit_n:5.1f}%, em={hit_p:5.1f}% | RV(bps) ev={rv_e:5.2f}, na={rv_n:5.2f}, em={rv_p:5.2f}")
            else:
                rv_e = m["rv_bps"]["t_event"]["mean"]
                rv_n = m["rv_bps"]["t_native"]["mean"]
                rv_p = m["rv_bps"]["t_emit"]["mean"]
                ar_e = m["abs_ret_bps"]["t_event"]["mean"]
                ar_n = m["abs_ret_bps"]["t_native"]["mean"]
                ar_p = m["abs_ret_bps"]["t_emit"]["mean"]
                print(f"  h={h:2d}m (n={r['n_paired']:3d}): |ret|(bps) ev={ar_e:5.2f}, na={ar_n:5.2f}, em={ar_p:5.2f} | RV(bps) ev={rv_e:5.2f}, na={rv_n:5.2f}, em={rv_p:5.2f}")

if __name__ == "__main__":
    main()
