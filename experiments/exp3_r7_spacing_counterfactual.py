"""Exp 3 (P0-3B): Cross-Implementation Stroke-Spacing Counterfactual across all 14 frozen R7 windows.

Uses the EXACT unmodified R7 matching engine (matching.match_layer, matching.metrics) and
read-only chan.py-main library to quantify how much of the B (30.31%) and S* (8.00%)
cross-implementation divergence is caused by minimum normalized-K center separation (m_B=2 vs 4)
versus additional chan.py fractal-overlap / peak guards and segment lifecycle rules.
"""
from __future__ import annotations
import copy
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
ADAPTER_DIR = Path(os.environ.get("CT_R7_ADAPTER_DIR", str(SCRIPT_DIR / "r7_adapter")))
CHANPY_ROOT = Path(os.environ.get("CT_CHANPY_ROOT", "./chan.py-main"))
WINDOWS_DIR = Path(os.environ.get("CT_WINDOWS_DIR", "./local_windows"))
MANIFEST_PATH = Path(os.environ.get("CT_MANIFEST_PATH", str(REPO_ROOT / "data" / "window_manifest.json")))
OUT_DIR = Path(os.environ.get("CT_RESULTS_DIR", "./results"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

sys.dont_write_bytecode = True
sys.path.insert(0, str(ADAPTER_DIR))
sys.path.insert(0, str(CHANPY_ROOT))

import matching  # noqa: E402
from Chan import CChan  # noqa: E402
from ChanConfig import CChanConfig  # noqa: E402
from Common.CEnum import AUTYPE, KL_TYPE, DATA_FIELD  # noqa: E402
from Common.CTime import CTime  # noqa: E402
from KLine.KLine_Unit import CKLine_Unit  # noqa: E402

MAPPING_PATH = ADAPTER_DIR / "r7_semantic_mapping.json"
if not MAPPING_PATH.exists():
    MAPPING_PATH = ADAPTER_DIR / "R7_SEMANTIC_MAPPING.json"
R7_MAPPING = json.loads(MAPPING_PATH.read_text(encoding="utf-8"))
BASE_CHANPY_CFG = R7_MAPPING["externalBaseline"]["proposedConfiguration"]


def run_chanpy_window(wid: str, instrument: str, bars: list[dict], cfg_overrides: dict) -> dict[str, list[dict]]:
    units = []
    for b in bars:
        dt = datetime.fromtimestamp(b["startTime"] / 1000, timezone.utc)
        nt = CTime(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, auto=False)
        u = CKLine_Unit({
            DATA_FIELD.FIELD_TIME: nt,
            DATA_FIELD.FIELD_OPEN: b["open"],
            DATA_FIELD.FIELD_HIGH: b["high"],
            DATA_FIELD.FIELD_LOW: b["low"],
            DATA_FIELD.FIELD_CLOSE: b["close"],
        }, autofix=False)
        units.append(u)
    cfg_dict = copy.deepcopy(BASE_CHANPY_CFG)
    cfg_dict.update(cfg_overrides)
    cfg = CChanConfig(cfg_dict)
    chan = CChan(code=instrument, config=cfg, lv_list=[KL_TYPE.K_1M], autype=AUTYPE.NONE)
    for u in units:
        chan.trigger_load({KL_TYPE.K_1M: [u]})
    kl = chan[KL_TYPE.K_1M]

    def support(k):
        return [u.idx for u in k.lst]

    def anchors(layer, s0, s1):
        return [min(s0) if layer == "K" else max(s0), max(s1), max(s1)]

    out = {l: [] for l in "KFBS"}
    for k in kl.lst:
        sup = support(k)
        out["K"].append(dict(
            id=f"chan.py/{wid}/K/{k.idx}",
            direction=k.dir.name,
            startSupport=sup, endSupport=sup,
            commonAnchors=anchors("K", sup, sup),
            comparableGeometry=[k.high, k.low],
            startRawIndex=sup[0], endRawIndex=sup[-1],
            eligible=True, exclusionReason=None,
        ))
        if k.fx.name in ("TOP", "BOTTOM"):
            peak = k.get_peak_klu(is_high=k.fx.name == "TOP")
            price = k.high if k.fx.name == "TOP" else k.low
            out["F"].append(dict(
                id=f"chan.py/{wid}/F/{k.idx}",
                direction=k.fx.name,
                startSupport=sup, endSupport=sup,
                commonAnchors=anchors("F", sup, sup),
                comparableGeometry=[price],
                geometricPeakRawIndex=peak.idx,
                startRawIndex=sup[0], endRawIndex=sup[-1],
                eligible=True, exclusionReason=None,
            ))
    for layer, seq in [("B", kl.bi_list), ("S", kl.seg_list)]:
        for obj in seq:
            begin = obj.begin_klc if layer == "B" else obj.start_bi.begin_klc
            end = obj.end_klc if layer == "B" else obj.end_bi.end_klc
            begu, endu = obj.get_begin_klu(), obj.get_end_klu()
            s0, s1 = support(begin), support(end)
            out[layer].append(dict(
                id=f"chan.py/{wid}/{layer}/{obj.idx}",
                direction=obj.dir.name,
                startSupport=s0, endSupport=s1,
                commonAnchors=anchors(layer, s0, s1),
                comparableGeometry=[obj.get_begin_val(), obj.get_end_val()],
                startRawIndex=begu.idx, endRawIndex=endu.idx,
                geometricPeakRawIndex=endu.idx,
                eligible=bool(obj.is_sure),
                exclusionReason=None if obj.is_sure else "NATIVE_UNSURE_EXCLUDED",
            ))
    return out


def aggregate_scenario(name: str, windows: list[dict], internal_by_win: dict, external_by_win: dict) -> dict:
    per_win = []
    totals = {l: dict(ni=0, ne=0, matched=0, exact=0, tol=0, geo_dis=0, amb_i=0, amb_e=0, win_covs=[]) for l in "KFBS"}
    for w in windows:
        wid = w["datasetId"]
        for l in "KFBS":
            i_recs = internal_by_win[wid][l]
            e_recs = external_by_win[wid][l]
            m = matching.match_layer(i_recs, e_recs, l)
            row = matching.metrics(i_recs, e_recs, m)
            row["windowId"] = wid
            per_win.append(row)
            t = totals[l]
            t["ni"] += row["internalCount"]
            t["ne"] += row["externalCount"]
            t["matched"] += row["acceptedCorrespondenceCount"]
            t["exact"] += row["exactMatchCount"]
            t["tol"] += row["toleranceMatchCount"]
            t["geo_dis"] += row["geometryDisagreementCount"]
            t["amb_i"] += row["ambiguousInternalCount"]
            t["amb_e"] += row["ambiguousExternalCount"]
            if row["matchedStructureRatio"] is not None:
                t["win_covs"].append(row["matchedStructureRatio"])
    summary = {}
    for l in "KFBS":
        t = totals[l]
        den = t["ni"] + t["ne"]
        micro_cov = (2 * t["matched"] / den) if den else None
        micro_exact = (2 * t["exact"] / den) if den else None
        win_covs = t["win_covs"]
        summary[l] = dict(
            internalCount=t["ni"],
            externalCount=t["ne"],
            countDifference=t["ni"] - t["ne"],
            uniqueMatchedCount=t["matched"],
            exactMatchCount=t["exact"],
            toleranceMatchCount=t["tol"],
            geometryDisagreementCount=t["geo_dis"],
            ambiguousCount=t["amb_i"] + t["amb_e"],
            microUniqueCoverage=round(micro_cov, 6) if micro_cov is not None else None,
            microExactCoverage=round(micro_exact, 6) if micro_exact is not None else None,
            macroWindowMedian=round(float(np.median(win_covs)), 6) if win_covs else None,
            macroWindowIQR=round(float(np.percentile(win_covs, 75) - np.percentile(win_covs, 25)), 6) if win_covs else None,
        )
    return dict(scenario=name, layers=summary)


def main():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    windows = [{"datasetId": w["windowId"], "instrument": w["instrument"]} for w in manifest["windows"]]
    internal_all = json.loads((OUT_DIR / "exp3_internal_projections.json").read_text(encoding="utf-8"))
    frozen_r7_layers = R7_MAPPING["frozenR7ReferenceSummary"]

    # Load frozen 14 window inputs
    bars_by_win = {}
    for w in windows:
        wid = w["datasetId"]
        bars_by_win[wid] = json.loads((WINDOWS_DIR / f"{wid}.json").read_text(encoding="utf-8"))["bars"]

    # Run chan.py under 3 configurations (read-only library!)
    ext_configs = {
        "ext_default": {},  # bi_strict=True, bi_fx_check='strict', bi_end_is_peak=True
        "ext_loose_span": {"bi_strict": False},  # relaxes span from >=4 to >=3 (and >=3 raw bars)
        "ext_relaxed_guards": {"bi_strict": True, "bi_fx_check": "loss", "bi_end_is_peak": False},  # keeps span>=4, removes extra FX-overlap & intermediate-peak guards
    }
    ext_results = {k: {} for k in ext_configs}
    for key, ov in ext_configs.items():
        for w in windows:
            wid = w["datasetId"]
            ext_results[key][wid] = run_chanpy_window(wid, w["instrument"], bars_by_win[wid], ov)
        print(f"Ran chan.py scenario '{key}' across 14 windows.")

    scenarios = [
        ("R7_BASELINE_m2_vs_strict", internal_all["internal_m2"], ext_results["ext_default"]),
        ("CF1_SPACING_ALIGNED_m4_vs_strict", internal_all["internal_m4"], ext_results["ext_default"]),
        ("CF2_EXTERNAL_LOOSE_m2_vs_bi_strict_false", internal_all["internal_m2"], ext_results["ext_loose_span"]),
        ("CF3_FULL_STROKE_ALIGN_m4_vs_relaxed_guards", internal_all["internal_m4"], ext_results["ext_relaxed_guards"]),
    ]

    results = {}
    for name, int_map, ext_map in scenarios:
        res = aggregate_scenario(name, windows, int_map, ext_map)
        results[name] = res
        print(f"\n=== {name} ===")
        for l in "KFBS":
            s = res["layers"][l]
            print(f"  {l}: nI={s['internalCount']:4d}, nE={s['externalCount']:4d}, matched={s['uniqueMatchedCount']:4d}, uniqueCov={s['microUniqueCoverage']*100:6.2f}%, exactCov={s['microExactCoverage']*100:6.2f}%, macroMed={s['macroWindowMedian']*100:6.2f}%")

    # Verify baseline matches published Table 10 R7 summary
    print("\n=== Baseline Verification vs Frozen R7 Summary ===")
    verify = {}
    for l in "KFBS":
        f_micro = frozen_r7_layers[l]
        b_micro = results["R7_BASELINE_m2_vs_strict"]["layers"][l]
        diff_ni = b_micro["internalCount"] - f_micro["internalEligibleCount"]
        diff_ne = b_micro["externalCount"] - f_micro["externalEligibleCount"]
        diff_cov = abs(b_micro["microUniqueCoverage"] - f_micro["uniqueCorrespondenceCoverage"])
        verify[l] = dict(
            frozen_nI=f_micro["internalEligibleCount"], sandbox_nI=b_micro["internalCount"],
            frozen_nE=f_micro["externalEligibleCount"], sandbox_nE=b_micro["externalCount"],
            frozen_cov=round(f_micro["uniqueCorrespondenceCoverage"], 6),
            sandbox_cov=b_micro["microUniqueCoverage"],
            abs_cov_diff=round(diff_cov, 6),
        )
        print(f"  {l}: frozen(nI={f_micro['internalEligibleCount']}, nE={f_micro['externalEligibleCount']}, cov={f_micro['uniqueCorrespondenceCoverage']*100:.2f}%) vs sandbox(nI={b_micro['internalCount']}, nE={b_micro['externalCount']}, cov={b_micro['microUniqueCoverage']*100:.2f}%)")

    out_path = OUT_DIR / "exp3_spacing_counterfactual.json"
    out_path.write_text(json.dumps({
        "schemaVersion": "PhysicaA-Exp3-SpacingCounterfactual-v1.0",
        "windowCount": len(windows),
        "baselineVerificationAgainstFrozenR7": verify,
        "scenarios": results,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"\nSaved: {out_path}")


if __name__ == "__main__":
    main()
