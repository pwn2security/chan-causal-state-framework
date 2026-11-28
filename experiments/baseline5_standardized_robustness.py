"""Exp 4 v24 Per-Window, Autocorrelation, and Volatility-Standardized Robustness (Table S12.2(b)-(c)):
Extends baseline5_overlap_robustness.py with:
  1. Same-family i.i.d. paired t-test p-values and within-window lag-1 autocorrelations (rho_1)
     explaining horizon-dependent Bartlett HAC variance behavior.
  2. Per-window Layer-B look-ahead breakdown at h = 5 min (n, 1-min return SD sigma_w, raw bps,
     reversal hit %, diffusion-standardized z_5 = rev_5 / (sqrt(5) * sigma_w), and Wilcoxon p_W).
  3. Pooled Brownian-diffusion-standardized z_h = rev_h / (sqrt(h) * sigma_w) with matched-lag
     Newey-West HAC p-values across h in {5, 15, 30, 60} min.
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
HORIZONS = [5, 15, 30, 60]
WINDOW_ORDER = [
    "BTCUSDT-2025-01-02-1s-derived-720",
    "R4-BTCUSDT-2026-06-FIXED-01",
    "R4-ETHUSDT-2026-06-FIXED-01",
    "R4-XAUUSDT-2026-06-FIXED-01",
    "R4-SPYUSDT-2026-06-FIXED-01",
]


def load_bars_map():
    return {p.stem: json.loads(p.read_text(encoding="utf-8"))["bars"] for p in R7_INPUTS.glob("*.json")}


def load_direction_map():
    meta = {}
    for slot in range(1, 6):
        sdir = P0_DIR / f"slot-{slot}"
        res = json.loads((sdir / "result.json").read_text(encoding="utf-8"))
        wid = res.get("windowId") or res.get("id") or res.get("datasetId") or res.get("window_id")
        sealed = json.loads((sdir / "final-sealed.json").read_text(encoding="utf-8"))
        for obj in sealed.get("strokes", []):
            sid = obj.get("structureId") or obj.get("id")
            direction = obj.get("direction")
            geom = obj.get("geometry", {})
            if direction is None and "startPrice" in geom and "endPrice" in geom:
                direction = "UP" if geom["endPrice"] >= geom["startPrice"] else "DOWN"
            meta[(wid, sid)] = direction
    return meta


def reversal_bps(bars, k0: int, k1: int, direction: str):
    if k0 < 0 or k1 >= len(bars):
        return None
    p0, p1 = float(bars[k0]["close"]), float(bars[k1]["close"])
    if p0 <= 0 or p1 <= 0:
        return None
    sign = 1.0 if direction == "UP" else -1.0
    return -sign * math.log(p1 / p0) * 1e4


def within_window_lag1_autocorr(items):
    """Pooled within-window lag-1 autocorrelation rho_1 on (wid, k_event, diff)."""
    vals = np.array([x[2] for x in items], dtype=float)
    mean_d = float(np.mean(vals))
    by_win = defaultdict(list)
    for wid, k_ev, d in items:
        by_win[wid].append((k_ev, d - mean_d))
    num = 0.0
    den = 0.0
    for arr in by_win.values():
        arr.sort(key=lambda x: x[0])
        u = [x[1] for x in arr]
        den += sum(v * v for v in u)
        num += sum(u[i] * u[i - 1] for i in range(1, len(u)))
    return num / den if den > 0 else 0.0


def panel_newey_west_p(items, lag_rank: int):
    """Multi-window Bartlett-kernel Newey-West HAC two-sided p-value."""
    n = len(items)
    vals = np.array([x[2] for x in items], dtype=float)
    mean_d = float(np.mean(vals))
    by_win = defaultdict(list)
    for wid, k_ev, d in items:
        by_win[wid].append((k_ev, d - mean_d))
    s0 = 0.0
    s_cov = 0.0
    for arr in by_win.values():
        arr.sort(key=lambda x: x[0])
        u = [x[1] for x in arr]
        m = len(u)
        s0 += sum(v * v for v in u)
        for ell in range(1, min(lag_rank, m - 1) + 1):
            w = 1.0 - ell / (lag_rank + 1.0)
            s_cov += 2.0 * w * sum(u[i] * u[i - ell] for i in range(ell, m))
    lrv = (s0 + s_cov) / n
    se = math.sqrt(max(lrv, 1e-12) / n)
    t_stat = mean_d / se
    return float(2.0 * stats.t.sf(abs(t_stat), df=n - 1))


def main():
    bars_by_win = load_bars_map()
    meta = load_direction_map()
    sigma_w = {}
    for wid, bars in bars_by_win.items():
        closes = [float(b["close"]) for b in bars]
        rets = [math.log(closes[i] / closes[i - 1]) * 1e4 for i in range(1, len(closes))]
        sigma_w[wid] = float(np.std(rets, ddof=1))

    events = []
    with (P0_DIR / "first_emission_records.csv").open("r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r["layer"] == "B" and r["in_terminal_sealed"].strip().lower() == "true":
                wid, sid = r["window_id"], r["structure_id"]
                d = meta.get((wid, sid))
                if d is None:
                    d = "UP" if sid.find(":BOTTOM:") < sid.find(":TOP:") else "DOWN"
                events.append({
                    "wid": wid,
                    "direction": d,
                    "k_event": int(r["k_event"]),
                    "k_native": int(r["k_native"]),
                    "k_emit": int(r["k_emit_first"]),
                })

    out = {"schemaVersion": "PhysicaA-Exp4-PerWindowStandardized-v1.0", "byHorizon": {}, "perWindowH5": {}}

    print("=== 1. Same-Family i.i.d. Paired t-Test, Lag-1 Autocorrelation, and Standardized NW(L) ===")
    lag_map = {5: 1, 15: 2, 30: 5, 60: 9}
    for h in HORIZONS:
        ev_em_raw, na_em_raw = [], []
        ev_em_z, na_em_z = [], []
        z_ev_l, z_na_l, z_em_l = [], [], []
        for ev in events:
            bars = bars_by_win[ev["wid"]]
            sigh = sigma_w[ev["wid"]] * math.sqrt(float(h))
            re_ = reversal_bps(bars, ev["k_event"], ev["k_event"] + h, ev["direction"])
            rn_ = reversal_bps(bars, ev["k_native"], ev["k_native"] + h, ev["direction"])
            rp_ = reversal_bps(bars, ev["k_emit"], ev["k_emit"] + h, ev["direction"])
            if None not in (re_, rn_, rp_):
                ev_em_raw.append((ev["wid"], ev["k_event"], re_ - rp_))
                na_em_raw.append((ev["wid"], ev["k_event"], rn_ - rp_))
                ev_em_z.append((ev["wid"], ev["k_event"], (re_ - rp_) / sigh))
                na_em_z.append((ev["wid"], ev["k_event"], (rn_ - rp_) / sigh))
                z_ev_l.append(re_ / sigh)
                z_na_l.append(rn_ / sigh)
                z_em_l.append(rp_ / sigh)

        d_ee = np.array([x[2] for x in ev_em_raw], dtype=float)
        d_ne = np.array([x[2] for x in na_em_raw], dtype=float)
        p_t_ee = float(stats.ttest_1samp(d_ee, 0.0)[1])
        p_t_ne = float(stats.ttest_1samp(d_ne, 0.0)[1])
        rho1_ee = within_window_lag1_autocorr(ev_em_raw)
        rho1_ne = within_window_lag1_autocorr(na_em_raw)
        p_nw_z_ee = panel_newey_west_p(ev_em_z, lag_map[h])
        p_nw_z_ne = panel_newey_west_p(na_em_z, lag_map[h])
        out["byHorizon"][str(h)] = {
            "n": len(d_ee),
            "ev_em_iid_pt": float(f"{p_t_ee:.4e}"),
            "ev_em_rho1": round(rho1_ee, 3),
            "na_em_iid_pt": float(f"{p_t_ne:.4e}"),
            "na_em_rho1": round(rho1_ne, 3),
            "z_mean_ev": round(float(np.mean(z_ev_l)), 3),
            "z_mean_na": round(float(np.mean(z_na_l)), 3),
            "z_mean_em": round(float(np.mean(z_em_l)), 3),
            "z_nw_p_ev_em": float(f"{p_nw_z_ee:.4e}"),
            "z_nw_p_na_em": float(f"{p_nw_z_ne:.4e}"),
        }
        print(
            f"  h={h:2d}m (n={len(d_ee)}): i.i.d. p_t(ev-em)={p_t_ee:.2e} rho1={rho1_ee:+.3f} | "
            f"i.i.d. p_t(na-em)={p_t_ne:.4f} rho1={rho1_ne:+.3f} | "
            f"z={np.mean(z_ev_l):+.2f}/{np.mean(z_na_l):+.2f}/{np.mean(z_em_l):+.2f} "
            f"NW_z p={p_nw_z_ee:.2e}/{p_nw_z_ne:.4f}"
        )

    print("\n=== 2. Per-Window Layer-B Breakdown at h = 5 min ===")
    for wid in WINDOW_ORDER:
        bars = bars_by_win[wid]
        sig1 = sigma_w[wid]
        sig5 = sig1 * math.sqrt(5.0)
        re_l, rn_l, rp_l = [], [], []
        for ev in events:
            if ev["wid"] != wid:
                continue
            re_ = reversal_bps(bars, ev["k_event"], ev["k_event"] + 5, ev["direction"])
            rn_ = reversal_bps(bars, ev["k_native"], ev["k_native"] + 5, ev["direction"])
            rp_ = reversal_bps(bars, ev["k_emit"], ev["k_emit"] + 5, ev["direction"])
            if None not in (re_, rn_, rp_):
                re_l.append(re_)
                rn_l.append(rn_)
                rp_l.append(rp_)
        re_a, rn_a, rp_a = np.array(re_l), np.array(rn_l), np.array(rp_l)
        p_w = float(stats.wilcoxon(re_a, rp_a, zero_method="wilcox")[1])
        out["perWindowH5"][wid] = {
            "n": len(re_a),
            "sigma_1m_bps": round(sig1, 2),
            "raw_mean_bps": {"ev": round(float(re_a.mean()), 2), "nat": round(float(rn_a.mean()), 2), "emit": round(float(rp_a.mean()), 2)},
            "hit_pct": {"ev": round(float(np.mean(re_a > 0) * 100), 1), "nat": round(float(np.mean(rn_a > 0) * 100), 1), "emit": round(float(np.mean(rp_a > 0) * 100), 1)},
            "z5_sigma": {"ev": round(float(re_a.mean() / sig5), 2), "nat": round(float(rn_a.mean() / sig5), 2), "emit": round(float(rp_a.mean() / sig5), 2)},
            "pW_ev_em": float(f"{p_w:.4e}"),
        }
        print(
            f"  {wid:34s} n={len(re_a):3d} sig1={sig1:5.2f} | "
            f"raw={re_a.mean():+6.2f}/{rn_a.mean():+5.2f}/{rp_a.mean():+5.2f} | "
            f"z5={re_a.mean()/sig5:+.2f}/{rn_a.mean()/sig5:+.2f}/{rp_a.mean()/sig5:+.2f} | pW={p_w:.2e}"
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "baseline5_standardized_robustness.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"\nSaved {out_path}")


if __name__ == "__main__":
    main()
