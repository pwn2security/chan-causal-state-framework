"""Official Binance Data Vision downloader, SHA-256 .CHECKSUM verifier,
protocol locker, deterministic window freezer, and data-quality auditor
for the extended-horizon, cross-frequency, and contiguous-scaling benchmark.

All paths default to repository-relative directories and can be overridden via
the --out-dir CLI flag or CT_DATA_ROOT environment variable.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ.get("CT_DATA_ROOT", str(REPO_ROOT / "local_data" / "extended_validation")))
VISION_BASE = "https://data.binance.vision/data/futures/um/monthly/klines"

SYMBOLS = ["BTCUSDT", "ETHUSDT", "XAUUSDT", "SPYUSDT"]
TICK_SIZES = {"BTCUSDT": 0.1, "ETHUSDT": 0.01, "XAUUSDT": 0.01, "SPYUSDT": 0.01}

# Preferred 6 independent mid-week Tue 00:00 UTC -> Thu 00:00 UTC windows across 6 separate months (2026-05..2026-10)
# Zero overlap with R4 Monday windows (06-08, 07-13, 08-10), zero US stock market holidays, 2 NYSE sessions each
ARM1_DATES = [
    ("2026-05", "2026-05-19"),
    ("2026-06", "2026-06-16"),
    ("2026-07", "2026-07-21"),
    ("2026-08", "2026-08-18"),
    ("2026-09", "2026-09-15"),
    ("2026-10", "2026-10-20"),
]
ARM1_BARS = 2880  # 48 hours of 1m bars

# Arm 2: 30 contiguous days of 15m bars in 2026-07 -> exact 2,880 bars
ARM2_MONTH = "2026-07"
ARM2_START = "2026-07-01"
ARM2_BARS = 2880  # 30 days * 24h * 4 bars/h

# Contiguous real BTCUSDT 10,000-bar 1m scaling stream (starts 2026-07-01 00:00 UTC, zero artificial seams)
SCALING_SYMBOL = "BTCUSDT"
SCALING_MONTH = "2026-07"
SCALING_START = "2026-07-01"
SCALING_BARS = 10000


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def http_get_bytes(url: str, retries: int = 5, timeout: int = 60) -> bytes:
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "CT-R8-Downloader/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status == 200:
                    return resp.read()
                raise RuntimeError(f"HTTP {resp.status} for {url}")
        except Exception as e:
            last_err = e
            time.sleep(min(2 ** attempt, 16))
    raise RuntimeError(f"Failed {url}: {last_err}")


def ensure_dirs() -> dict[str, Path]:
    dirs = {
        "root": ROOT,
        "protocol": ROOT / "protocol",
        "raw_1m": ROOT / "raw" / "1m",
        "raw_15m": ROOT / "raw" / "15m",
        "checksums": ROOT / "checksums",
        "arm1": ROOT / "windows" / "arm1_1m_48h",
        "arm2": ROOT / "windows" / "arm2_15m_30d",
        "scaling": ROOT / "windows" / "scaling_contiguous",
        "manifests": ROOT / "manifests",
        "results": ROOT / "results",
        "scripts": ROOT / "scripts",
    }
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)
    return dirs


def download_one(interval: str, symbol: str, month: str, dirs: dict[str, Path]) -> dict:
    url = f"{VISION_BASE}/{symbol}/{interval}/{symbol}-{interval}-{month}.zip"
    chk_url = url + ".CHECKSUM"
    raw_dir = (dirs["raw_1m"] if interval == "1m" else dirs["raw_15m"]) / symbol
    raw_dir.mkdir(parents=True, exist_ok=True)
    zip_path = raw_dir / f"{symbol}-{interval}-{month}.zip"
    chk_path = dirs["checksums"] / f"{zip_path.name}.CHECKSUM"

    official_chk_text = http_get_bytes(chk_url).decode("utf-8").strip()
    official_sha = official_chk_text.split()[0].lower()
    chk_path.write_text(official_chk_text + "\n", encoding="utf-8")

    if zip_path.exists() and sha256_file(zip_path) == official_sha:
        action = "SKIP_HASH_MATCH"
    else:
        data = http_get_bytes(url, timeout=120)
        got_sha = sha256_bytes(data)
        if got_sha != official_sha:
            raise RuntimeError(f"CHECKSUM_MISMATCH {zip_path.name}: got={got_sha} expected={official_sha}")
        tmp = zip_path.with_suffix(".zip.partial")
        tmp.write_bytes(data)
        tmp.replace(zip_path)
        action = "DOWNLOADED_VERIFIED"

    return {
        "symbol": symbol,
        "interval": interval,
        "month": month,
        "url": url,
        "localPath": str(zip_path),
        "bytes": zip_path.stat().st_size,
        "officialSha256": official_sha,
        "verifiedSha256": sha256_file(zip_path),
        "action": action,
    }


def load_zip_klines(zip_path: Path) -> list[dict]:
    rows = []
    with zipfile.ZipFile(zip_path, "r") as zf:
        csv_names = [n for n in zf.namelist() if n.endswith(".csv")]
        assert len(csv_names) == 1, f"Expected 1 CSV in {zip_path}, got {csv_names}"
        with zf.open(csv_names[0], "r") as fh:
            text_stream = io.TextIOWrapper(fh, encoding="utf-8")
            reader = csv.reader(text_stream)
            for row in reader:
                if not row:
                    continue
                # Skip header row if present (Binance Vision 2026 klines include header)
                if not row[0].isdigit():
                    continue
                open_ms = int(row[0])
                o = float(row[1])
                h = float(row[2])
                l = float(row[3])
                c = float(row[4])
                vol = float(row[5])
                close_ms = int(row[6])
                quote_vol = float(row[7])
                trades = int(row[8])
                rows.append({
                    "startTime": open_ms,
                    "endTime": close_ms,
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": c,
                    "volume": vol,
                    "quoteVolume": quote_vol,
                    "tradeCount": trades,
                })
    return rows


def audit_and_freeze_window(
    window_id: str,
    symbol: str,
    interval: str,
    step_ms: int,
    all_rows: list[dict],
    start_date_str: str,
    target_bars: int,
    out_path: Path,
    source_zip: Path,
    source_zip_sha: str,
) -> tuple[dict, dict]:
    t0_dt = datetime.strptime(start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    t0_ms = int(t0_dt.timestamp() * 1000)

    selected = [r for r in all_rows if r["startTime"] >= t0_ms][:target_bars]
    if len(selected) != target_bars:
        raise RuntimeError(f"{window_id}: expected {target_bars} bars, got {len(selected)}")

    bars = []
    missing_steps = 0
    zero_vol = 0
    zero_range = 0
    eq_bound = 0
    ohlc_violations = 0
    max_abs_ret = 0.0

    # Session breakdown (specifically useful for SPYUSDT NYSE 13:30-20:00 UTC vs off-hours 00:00-12:00 UTC)
    nyse_total = nyse_zr = nyse_zv = nyse_eb = 0
    off_total = off_zr = off_zv = off_eb = 0

    for i, r in enumerate(selected):
        if i > 0:
            dt_ms = r["startTime"] - selected[i - 1]["startTime"]
            if dt_ms != step_ms:
                missing_steps += max(1, (dt_ms // step_ms) - 1)
            prev_c = selected[i - 1]["close"]
            if prev_c > 0:
                max_abs_ret = max(max_abs_ret, abs(r["close"] - prev_c) / prev_c)
            is_eb = (r["high"] == selected[i - 1]["high"]) or (r["low"] == selected[i - 1]["low"])
            if is_eb:
                eq_bound += 1
        else:
            is_eb = False

        o, h, l, c = r["open"], r["high"], r["low"], r["close"]
        if not (l <= min(o, c) and max(o, c) <= h and l > 0):
            ohlc_violations += 1
        is_zr = (h == l)
        is_zv = (r["volume"] == 0.0)
        if is_zr:
            zero_range += 1
        if is_zv:
            zero_vol += 1

        # UTC minute of day
        dt_u = datetime.fromtimestamp(r["startTime"] / 1000.0, tz=timezone.utc)
        mod = dt_u.hour * 60 + dt_u.minute
        if 13 * 60 + 30 <= mod < 20 * 60:
            nyse_total += 1
            if is_zr: nyse_zr += 1
            if is_zv: nyse_zv += 1
            if is_eb: nyse_eb += 1
        elif 0 <= mod < 12 * 60:
            off_total += 1
            if is_zr: off_zr += 1
            if is_zv: off_zv += 1
            if is_eb: off_eb += 1

        bars.append({
            "index": i,
            "startTime": r["startTime"],
            "endTime": r["endTime"],
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": r["volume"],
            "tradeCount": r["tradeCount"],
        })

    start_utc = datetime.fromtimestamp(bars[0]["startTime"] / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    end_utc = datetime.fromtimestamp(bars[-1]["endTime"] / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    payload = {
        "windowId": window_id,
        "protocolId": "CT-R8-ExtendedHorizon-CrossFreq-Null-v1.0.0",
        "symbol": symbol,
        "interval": interval,
        "tickSize": TICK_SIZES[symbol],
        "startUtc": start_utc,
        "endUtc": end_utc,
        "barCount": len(bars),
        "sourceZipName": source_zip.name,
        "sourceZipSha256": source_zip_sha,
        "bars": bars,
    }
    raw_json = (json.dumps(payload, indent=2) + "\n").encode("utf-8")
    out_path.write_bytes(raw_json)
    win_sha = sha256_bytes(raw_json)

    manifest_entry = {
        "windowId": window_id,
        "symbol": symbol,
        "interval": interval,
        "startDate": start_date_str,
        "startUtc": start_utc,
        "endUtc": end_utc,
        "barCount": len(bars),
        "tickSize": TICK_SIZES[symbol],
        "sourceZip": source_zip.name,
        "sourceZipSha256": source_zip_sha,
        "filePath": out_path.relative_to(ROOT).as_posix() if out_path.is_relative_to(ROOT) else str(out_path),
        "fileSha256": win_sha,
    }
    qa_entry = {
        "windowId": window_id,
        "symbol": symbol,
        "interval": interval,
        "barCount": len(bars),
        "missingSteps": missing_steps,
        "ohlcViolations": ohlc_violations,
        "zeroVolumeBars": zero_vol,
        "zeroRangeBars": zero_range,
        "zeroRangePct": round(100.0 * zero_range / len(bars), 4),
        "equalBoundPairs": eq_bound,
        "equalBoundPct": round(100.0 * eq_bound / (len(bars) - 1), 4),
        "maxAbsCloseRetPct": round(100.0 * max_abs_ret, 4),
        "sessionBreakdown": {
            "nyse_1330_2000_utc": {
                "bars": nyse_total,
                "zeroRangePct": round(100.0 * nyse_zr / nyse_total, 4) if nyse_total else None,
                "zeroVolBars": nyse_zv,
                "equalBoundPct": round(100.0 * nyse_eb / nyse_total, 4) if nyse_total else None,
            },
            "offhours_0000_1200_utc": {
                "bars": off_total,
                "zeroRangePct": round(100.0 * off_zr / off_total, 4) if off_total else None,
                "zeroVolBars": off_zv,
                "equalBoundPct": round(100.0 * off_eb / off_total, 4) if off_total else None,
            },
        },
    }
    return manifest_entry, qa_entry


def main():
    global ROOT
    ap = argparse.ArgumentParser(description="Download official Binance Data Vision monthly klines and freeze extended benchmark windows.")
    ap.add_argument("--out-dir", type=Path, default=ROOT, help="Output data root (default: $CT_DATA_ROOT or ./local_data/extended_validation)")
    args = ap.parse_args()
    ROOT = args.out_dir.resolve()
    dirs = ensure_dirs()

    # 1. Copy verified exchangeInfo tick-size snapshot from repository manifests (or fetch live)
    repo_exinfo = REPO_ROOT / "manifests" / "exchange_info_tick_snapshot.json"
    if repo_exinfo.exists():
        (dirs["protocol"] / "exchange_info_tick_snapshot.json").write_text(
            repo_exinfo.read_text(encoding="utf-8"), encoding="utf-8"
        )
    else:
        raw_info = json.loads(http_get_bytes("https://fapi.binance.com/fapi/v1/exchangeInfo").decode("utf-8"))
        filtered = {s["symbol"]: s for s in raw_info.get("symbols", []) if s["symbol"] in SYMBOLS}
        (dirs["protocol"] / "exchange_info_tick_snapshot.json").write_text(
            json.dumps(filtered, indent=2) + "\n", encoding="utf-8"
        )

    # 2. Write immutable protocol lock BEFORE processing any window
    protocol_lock = {
        "protocolId": "CT-R8-ExtendedHorizon-CrossFreq-Null-v1.0.0",
        "lockedAtUtc": utc_now(),
        "frozenParserVersion": "CT-Core-Parser-R1.0.4",
        "ruleVariant": "Variant A (Snapshot v5)",
        "sandboxEquivalenceMode": "audit_hooks_off (must pass 8-trajectory 100% SHA-256 spotcheck vs full_audit)",
        "symbols": SYMBOLS,
        "tickSizesOfficialExchangeInfo": TICK_SIZES,
        "arm1": {
            "description": "24 extended-horizon weekday 48h 1m windows (4 symbols x 6 separate months, Tue 00:00 UTC -> Thu 00:00 UTC)",
            "dateSetChoice": "PREFERRED_6_MONTH_SET_2026_05_TO_2026_10",
            "dates": [{"month": m, "startDateUtc": d} for m, d in ARM1_DATES],
            "barsPerWindow": ARM1_BARS,
            "nullPathsPerWindowPerModel": 25,
        },
        "arm2": {
            "description": "4 cross-frequency contiguous 30-day 15m windows (2026-07-01 00:00 UTC -> 2026-07-31 00:00 UTC)",
            "month": ARM2_MONTH,
            "startDateUtc": ARM2_START,
            "barsPerWindow": ARM2_BARS,
            "nullPathsPerWindowPerModel": 25,
        },
        "arm3": {
            "description": "Standard Chan new-Stroke (m_B = 4) robustness branch on Arm 1 24 windows",
            "mB": 4,
            "nullPathsPerWindowPerModel": 10,
            "nullModels": ["shuffled_L1", "cbb_L30", "tq_gbm", "tq_garch"],
        },
        "contiguousScaling": {
            "symbol": SCALING_SYMBOL,
            "month": SCALING_MONTH,
            "startDateUtc": SCALING_START,
            "bars": SCALING_BARS,
            "checkpoints": [120, 500, 1000, 2000, 2880, 5000, 10000],
        },
        "seeds": {
            "BASE_SEED": 20261201,
            "offsets": {
                "shuffled_L1": 10007,
                "cbb_L30": 20011,
                "cbb_L15": 20023,
                "cbb_L60": 20047,
                "sbb_L30": 20063,
                "cont_gbm": 30013,
                "tq_gbm": 40009,
                "tq_garch": 50021,
            },
        },
        "hypotheses": {
            "H1": "Operator invariance of B/K (~17-18% at m_B=2; ~7.8% at m_B=4) across 1m & 15m real vs all null models",
            "H2": "Date-clustered K/N compression: Real < TQ-GBM across 6/6 independent dates (exact Wilcoxon p_date = 0.03125 < 0.05)",
            "H3": "Volatility-clustering relief of bar inclusion: CBB(L=30) K/N > Shuffled(L=1) K/N (p_date < 0.05)",
            "H4": "Conditional heteroskedasticity driver: TQ-GARCH lowers K/N and stretches Segment lags relative to TQ-GBM",
            "H5": "Cross-frequency persistence at 15m (low flat-bar regime) and zero-mean noise convergence at causal t_emit",
        },
    }
    lock_path = dirs["protocol"] / "extended_protocol_lock.json"
    lock_path.write_text(json.dumps(protocol_lock, indent=2) + "\n", encoding="utf-8")
    print(f"Locked protocol: {lock_path} (SHA-256: {sha256_file(lock_path)[:16]}...)")

    # 3. Download all 24 1m monthly ZIPs + 4 15m monthly ZIPs in parallel (6 threads)
    tasks = []
    for m, _ in ARM1_DATES:
        for sym in SYMBOLS:
            tasks.append(("1m", sym, m))
    for sym in SYMBOLS:
        tasks.append(("15m", sym, ARM2_MONTH))

    print(f"\nDownloading & verifying {len(tasks)} official Binance Vision monthly ZIPs...")
    download_records = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(download_one, iv, sym, m, dirs): (iv, sym, m) for iv, sym, m in tasks}
        for fut in as_completed(futs):
            rec = fut.result()
            download_records.append(rec)
            print(f"  [{rec['action']}] {rec['symbol']}-{rec['interval']}-{rec['month']} ({rec['bytes']:,} B)")

    download_records.sort(key=lambda r: (r["interval"], r["month"], r["symbol"]))
    (dirs["manifests"] / "extended_raw_download_index.json").write_text(
        json.dumps({"generatedAtUtc": utc_now(), "files": download_records}, indent=2) + "\n",
        encoding="utf-8",
    )

    rec_map = {(r["interval"], r["symbol"], r["month"]): r for r in download_records}

    # 4. Freeze Arm 1 (24 windows), Arm 2 (4 windows), and Contiguous 10,000-bar BTCUSDT scaling stream
    manifest_arm1, qa_arm1 = [], []
    print("\nFreezing Arm 1 (24 weekday 48h 1m windows)...")
    for m, start_d in ARM1_DATES:
        for sym in SYMBOLS:
            rec = rec_map[("1m", sym, m)]
            zp = Path(rec["localPath"])
            rows = load_zip_klines(zp)
            wid = f"R8-ARM1-{sym}-{start_d}-48H-1M"
            out_p = dirs["arm1"] / f"{wid}.json"
            me, qa = audit_and_freeze_window(
                wid, sym, "1m", 60_000, rows, start_d, ARM1_BARS, out_p, zp, rec["verifiedSha256"]
            )
            manifest_arm1.append(me)
            qa_arm1.append(qa)
            print(f"  {wid}: bars={qa['barCount']} miss={qa['missingSteps']} zeroVol={qa['zeroVolumeBars']} ZR%={qa['zeroRangePct']:.2f} EqB%={qa['equalBoundPct']:.2f}")

    manifest_arm2, qa_arm2 = [], []
    print("\nFreezing Arm 2 (4 contiguous 30d 15m windows)...")
    for sym in SYMBOLS:
        rec = rec_map[("15m", sym, ARM2_MONTH)]
        zp = Path(rec["localPath"])
        rows = load_zip_klines(zp)
        wid = f"R8-ARM2-{sym}-{ARM2_MONTH}-30D-15M"
        out_p = dirs["arm2"] / f"{wid}.json"
        me, qa = audit_and_freeze_window(
            wid, sym, "15m", 900_000, rows, ARM2_START, ARM2_BARS, out_p, zp, rec["verifiedSha256"]
        )
        manifest_arm2.append(me)
        qa_arm2.append(qa)
        print(f"  {wid}: bars={qa['barCount']} miss={qa['missingSteps']} zeroVol={qa['zeroVolumeBars']} ZR%={qa['zeroRangePct']:.2f} EqB%={qa['equalBoundPct']:.2f}")

    print("\nFreezing Contiguous 10,000-bar BTCUSDT 1m scaling stream...")
    rec_sc = rec_map[("1m", SCALING_SYMBOL, SCALING_MONTH)]
    rows_sc = load_zip_klines(Path(rec_sc["localPath"]))
    wid_sc = f"R8-SCALING-{SCALING_SYMBOL}-{SCALING_START}-10000-1M"
    me_sc, qa_sc = audit_and_freeze_window(
        wid_sc, SCALING_SYMBOL, "1m", 60_000, rows_sc, SCALING_START, SCALING_BARS,
        dirs["scaling"] / f"{wid_sc}.json", Path(rec_sc["localPath"]), rec_sc["verifiedSha256"]
    )
    print(f"  {wid_sc}: bars={qa_sc['barCount']} miss={qa_sc['missingSteps']} ZR%={qa_sc['zeroRangePct']:.2f}")

    # 5. Write manifests & QA audit
    win_manifest = {
        "protocolId": "CT-R8-ExtendedHorizon-CrossFreq-Null-v1.0.0",
        "generatedAtUtc": utc_now(),
        "arm1_1m_48h": manifest_arm1,
        "arm2_15m_30d": manifest_arm2,
        "scaling_contiguous": [me_sc],
    }
    qa_report = {
        "protocolId": "CT-R8-ExtendedHorizon-CrossFreq-Null-v1.0.0",
        "generatedAtUtc": utc_now(),
        "arm1_1m_48h": qa_arm1,
        "arm2_15m_30d": qa_arm2,
        "scaling_contiguous": [qa_sc],
    }
    (dirs["manifests"] / "extended_window_manifest.json").write_text(
        json.dumps(win_manifest, indent=2) + "\n", encoding="utf-8"
    )
    (dirs["manifests"] / "extended_data_quality_audit.json").write_text(
        json.dumps(qa_report, indent=2) + "\n", encoding="utf-8"
    )

    # Summary of SPYUSDT NYSE vs Off-hours across all 6 Arm-1 windows
    spy_qa = [q for q in qa_arm1 if q["symbol"] == "SPYUSDT"]
    print("\n=== SPYUSDT ARM-1 SESSION MICROSTRUCTURE (NYSE 13:30-20:00 vs OFF-HOURS 00:00-12:00 UTC) ===")
    for q in spy_qa:
        ny = q["sessionBreakdown"]["nyse_1330_2000_utc"]
        of = q["sessionBreakdown"]["offhours_0000_1200_utc"]
        print(f"  {q['windowId']}: ALL ZR={q['zeroRangePct']:.2f}% EqB={q['equalBoundPct']:.2f}% | "
              f"NYSE ZR={ny['zeroRangePct']:.2f}% EqB={ny['equalBoundPct']:.2f}% | "
              f"OFF ZR={of['zeroRangePct']:.2f}% EqB={of['equalBoundPct']:.2f}%")

    print("\nALL R8 DATA DOWNLOADED, VERIFIED, AND FROZEN SUCCESSFULLY!")


if __name__ == "__main__":
    main()
