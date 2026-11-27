"""Exp 3 v22 CF-4 Matcher (Major 4C):
Evaluates CF-4 (Internal m_B=4 + Variant B [G_extreme disabled] vs frozen chan.py strict)
and CF-4b (Internal m_B=2 + Variant B vs frozen chan.py strict) using the EXACT unmodified R7
matching engine (matching.match_layer, matching.metrics).
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
BASE_CHANPY_CFG = json.loads(MAPPING_PATH.read_text(encoding="utf-8"))["externalBaseline"]["proposedConfiguration"]


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
            id=f"chan.py/{wid}/K/{k.idx}", direction=k.dir.name, startSupport=sup, endSupport=sup,
            commonAnchors=anchors("K", sup, sup), comparableGeometry=[k.high, k.low],
            startRawIndex=sup[0], endRawIndex=sup[-1], eligible=True, exclusionReason=None,
        ))
        if k.fx.name in ("TOP", "BOTTOM"):
            peak = k.get_peak_klu(is_high=k.fx.name == "TOP")
            price = k.high if k.fx.name == "TOP" else k.low
            out["F"].append(dict(
                id=f"chan.py/{wid}/F/{k.idx}", direction=k.fx.name, startSupport=sup, endSupport=sup,
                commonAnchors=anchors("F", sup, sup), comparableGeometry=[price],
                geometricPeakRawIndex=peak.idx, startRawIndex=sup[0], endRawIndex=sup[-1],
                eligible=True, exclusionReason=None,
            ))
    for layer, seq in [("B", kl.bi_list), ("S", kl.seg_list)]:
        for obj in seq:
            begin = obj.begin_klc if layer == "B" else obj.start_bi.begin_klc
            end = obj.end_klc if layer == "B" else obj.end_bi.end_klc
            begu, endu = obj.get_begin_klu(), obj.get_end_klu()
            s0, s1 = support(begin), support(end)
            out[layer].append(dict(
                id=f"chan.py/{wid}/{layer}/{obj.idx}", direction=obj.dir.name, startSupport=s0, endSupport=s1,
                commonAnchors=anchors(layer, s0, s1), comparableGeometry=[obj.get_begin_val(), obj.get_end_val()],
                startRawIndex=begu.idx, endRawIndex=endu.idx, geometricPeakRawIndex=endu.idx,
                eligible=bool(obj.is_sure), exclusionReason=None if obj.is_sure else "NATIVE_UNSURE_EXCLUDED",
            ))
    return out


def aggregate_scenario(name: str, windows: list[dict], internal_by_win: dict, external_by_win: dict) -> dict:
    totals = {l: dict(ni=0, ne=0, matched=0, exact=0, win_covs=[]) for l in "KFBS"}
    for w in windows:
        wid = w["datasetId"]
        for l in "KFBS":
            i_recs = internal_by_win[wid][l]
            e_recs = external_by_win[wid][l]
            m = matching.match_layer(i_recs, e_recs, l)
            row = matching.metrics(i_recs, e_recs, m)
            t = totals[l]
            t["ni"] += row["internalCount"]
            t["ne"] += row["externalCount"]
            t["matched"] += row["acceptedCorrespondenceCount"]
            t["exact"] += row["exactMatchCount"]
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
            internalCount=t["ni"], externalCount=t["ne"], uniqueMatchedCount=t["matched"],
            exactMatchCount=t["exact"],
            microUniqueCoverage=round(micro_cov, 6) if micro_cov is not None else None,
            microExactCoverage=round(micro_exact, 6) if micro_exact is not None else None,
            macroWindowMedian=round(float(np.median(win_covs)), 6) if win_covs else None,
        )
    return dict(scenario=name, layers=summary)


def main():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    windows = [{"datasetId": w["windowId"], "instrument": w["instrument"]} for w in manifest["windows"]]
    varb = json.loads((OUT_DIR / "exp3_v22_varB_projections.json").read_text(encoding="utf-8"))
    bars_by_win = {
        w["datasetId"]: json.loads((WINDOWS_DIR / f"{w['datasetId']}.json").read_text(encoding="utf-8"))["bars"]
        for w in windows
    }
    ext_default = {w["datasetId"]: run_chanpy_window(w["datasetId"], w["instrument"], bars_by_win[w["datasetId"]], {}) for w in windows}
    ext_relaxed = {
        w["datasetId"]: run_chanpy_window(
            w["datasetId"], w["instrument"], bars_by_win[w["datasetId"]],
            {"bi_strict": True, "bi_fx_check": "loss", "bi_end_is_peak": False}
        )
        for w in windows
    }
    scenarios = [
        ("CF4_m4_varB_vs_strict", varb["internal_m4_varB"], ext_default),
        ("CF4b_m2_varB_vs_strict", varb["internal_m2_varB"], ext_default),
        ("CF4c_m4_varB_vs_relaxed", varb["internal_m4_varB"], ext_relaxed),
    ]
    out = {"schemaVersion": "PhysicaA-Exp3-CF4-v1.0", "totals": varb["totals"], "scenarios": {}}
    for name, int_map, ext_map in scenarios:
        res = aggregate_scenario(name, windows, int_map, ext_map)
        out["scenarios"][name] = res
        print(f"=== {name} ===")
        for l in "KFBS":
            s = res["layers"][l]
            print(f"  {l}: nI={s['internalCount']:4d}, nE={s['externalCount']:4d}, M={s['uniqueMatchedCount']:4d}, exact={s['exactMatchCount']:4d}, micro={s['microUniqueCoverage']*100:6.2f}%, exactCov={s['microExactCoverage']*100:6.2f}%, macroMed={s['macroWindowMedian']*100:6.2f}%")
    out_path = OUT_DIR / "exp3_v22_cf4.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()
