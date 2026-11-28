"""Official Binance Data Vision USD-M monthly kline crawler, exchangeInfo auditor, and window freezer.

Retrieves SHA-256-verified official monthly kline archives from:
  https://data.binance.vision/data/futures/um/monthly/klines/<SYMBOL>/<INTERVAL>/<SYMBOL>-<INTERVAL>-<YYYY-MM>.zip

Also queries the public Binance USD-M `/fapi/v1/exchangeInfo` endpoint (no API key
required) to audit contract types, underlying exposure metadata, and official
`PRICE_FILTER.tickSize` increments, and validates monotonic timestamps, zero
missing bars, and OHLC consistency with zero synthetic interpolation.

Supports two presets matching the exact empirical windows in the manuscript:
  - `--preset historical12`: 12 fixed 12-hour 1-min windows (June-August 2026,
    second Monday 00:00 UTC, N=720 bars; Section 3.1, Section 4.4, Table 6).
  - `--preset extended29`: 24 extended 48-h 1-min windows across six months
    (Arm 1 & Arm 3), four 30-day 15-min zero-flat-bar windows (Arm 2), and the
    contiguous 10,000-bar BTCUSDT scaling stream (Sections 3.2-3.3, Tables 3-5,
    Figures 4-5, Figure 8).
  - `--preset all`: Downloads and verifies both sets.

Usage example:
  python data/acquisition/download_binance_monthly_klines.py \
      --preset extended29 --out-dir ./local_data/extended_validation
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

VISION_BASE = "https://data.binance.vision/data/futures/um/monthly/klines"
EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo"

SYMBOLS = ["BTCUSDT", "ETHUSDT", "XAUUSDT", "SPYUSDT"]
OFFICIAL_TICKS = {"BTCUSDT": 0.1, "ETHUSDT": 0.01, "XAUUSDT": 0.01, "SPYUSDT": 0.01}

HISTORICAL_12_DATES = [
    ("2026-06", "2026-06-08"),
    ("2026-07", "2026-07-13"),
    ("2026-08", "2026-08-10"),
]

EXTENDED_ARM1_DATES = [
    ("2026-05", "2026-05-19"),
    ("2026-06", "2026-06-16"),
    ("2026-07", "2026-07-21"),
    ("2026-08", "2026-08-18"),
    ("2026-09", "2026-09-15"),
    ("2026-10", "2026-10-20"),
]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def http_get_bytes(url: str, retries: int = 5, timeout: int = 60) -> bytes:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ChanFramework-KlineCrawler/2.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status == 200:
                    return resp.read()
                raise RuntimeError(f"HTTP {resp.status} for {url}")
        except Exception as exc:
            last_err = exc
            time.sleep(min(2 ** attempt, 16))
    raise RuntimeError(f"Download failed for {url}: {last_err}")


def audit_exchange_info(out_path: Path) -> dict:
    raw = json.loads(http_get_bytes(EXCHANGE_INFO_URL, timeout=30).decode("utf-8"))
    by_sym = {row["symbol"]: row for row in raw.get("symbols", [])}
    summary = {}
    for sym in SYMBOLS:
        rec = by_sym.get(sym, {})
        tick = None
        for flt in rec.get("filters", []):
            if flt.get("filterType") == "PRICE_FILTER":
                tick = flt.get("tickSize")
        summary[sym] = {
            "contractType": rec.get("contractType"),
            "underlyingType": rec.get("underlyingType"),
            "baseAsset": rec.get("baseAsset"),
            "quoteAsset": rec.get("quoteAsset"),
            "tickSize": tick,
            "pricePrecision": rec.get("pricePrecision"),
            "status": rec.get("status"),
        }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"fetchedAtUtc": utc_now(), "symbols": summary}, indent=2) + "\n", encoding="utf-8")
    return summary


def download_monthly_zip(interval: str, symbol: str, month: str, raw_root: Path, chk_root: Path) -> dict:
    url = f"{VISION_BASE}/{symbol}/{interval}/{symbol}-{interval}-{month}.zip"
    dest_dir = raw_root / interval / symbol
    dest_dir.mkdir(parents=True, exist_ok=True)
    chk_root.mkdir(parents=True, exist_ok=True)
    zip_path = dest_dir / f"{symbol}-{interval}-{month}.zip"
    chk_path = chk_root / f"{zip_path.name}.CHECKSUM"

    chk_text = http_get_bytes(url + ".CHECKSUM", timeout=30).decode("utf-8").strip()
    official_sha = chk_text.split()[0].lower()
    chk_path.write_text(chk_text + "\n", encoding="utf-8")

    if zip_path.exists() and sha256_file(zip_path) == official_sha:
        action = "SKIP_HASH_MATCH"
    else:
        payload = http_get_bytes(url, timeout=120)
        got_sha = sha256_bytes(payload)
        if got_sha != official_sha:
            raise RuntimeError(f"CHECKSUM_MISMATCH for {zip_path.name}: expected={official_sha} got={got_sha}")
        tmp = zip_path.with_suffix(".zip.partial")
        tmp.write_bytes(payload)
        tmp.replace(zip_path)
        action = "DOWNLOADED_VERIFIED"

    return {
        "symbol": symbol,
        "interval": interval,
        "month": month,
        "url": url,
        "localPath": str(zip_path),
        "verifiedSha256": sha256_file(zip_path),
        "action": action,
    }


def parse_kline_zip(zip_path: Path) -> list[dict]:
    rows: list[dict] = []
    with zipfile.ZipFile(zip_path, "r") as zf:
        csv_name = next(n for n in zf.namelist() if n.endswith(".csv"))
        with zf.open(csv_name, "r") as raw:
            reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8"))
            for row in reader:
                if not row or not row[0].isdigit():
                    continue
                rows.append({
                    "startTime": int(row[0]),
                    "open": float(row[1]),
                    "high": float(row[2]),
                    "low": float(row[3]),
                    "close": float(row[4]),
                    "volume": float(row[5]),
                    "endTime": int(row[6]),
                    "tradeCount": int(row[8]),
                })
    return rows


def freeze_window(
    window_id: str,
    symbol: str,
    interval: str,
    step_ms: int,
    rows: list[dict],
    start_date: str,
    target_bars: int,
    out_path: Path,
    source_zip: Path,
    source_sha: str,
    out_root: Path,
) -> dict:
    t0_ms = int(datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
    selected = [r for r in rows if r["startTime"] >= t0_ms][:target_bars]
    if len(selected) != target_bars:
        raise RuntimeError(f"{window_id}: expected {target_bars} bars, got {len(selected)}")

    missing_steps = 0
    ohlc_errors = 0
    bars = []
    for i, r in enumerate(selected):
        if i > 0 and (r["startTime"] - selected[i - 1]["startTime"]) != step_ms:
            missing_steps += 1
        if not (r["low"] <= min(r["open"], r["close"]) and max(r["open"], r["close"]) <= r["high"] and r["low"] > 0):
            ohlc_errors += 1
        bars.append({"index": i, **r})

    if missing_steps > 0 or ohlc_errors > 0:
        raise RuntimeError(f"{window_id}: quality check failed (missing={missing_steps}, ohlc_errors={ohlc_errors})")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "windowId": window_id,
        "symbol": symbol,
        "interval": interval,
        "tickSize": OFFICIAL_TICKS[symbol],
        "barCount": len(bars),
        "sourceZipName": source_zip.name,
        "sourceZipSha256": source_sha,
        "bars": bars,
    }
    raw_bytes = (json.dumps(payload, indent=2) + "\n").encode("utf-8")
    out_path.write_bytes(raw_bytes)
    return {
        "windowId": window_id,
        "symbol": symbol,
        "interval": interval,
        "startDate": start_date,
        "barCount": len(bars),
        "filePath": out_path.relative_to(out_root).as_posix(),
        "fileSha256": sha256_bytes(raw_bytes),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Download official Binance Data Vision monthly klines and freeze validated windows.")
    ap.add_argument("--preset", choices=["historical12", "extended29", "all"], default="extended29")
    ap.add_argument("--out-dir", type=Path, default=Path("./local_data/extended_validation"))
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--skip-exchange-info", action="store_true", help="Skip live /fapi/v1/exchangeInfo query")
    args = ap.parse_args()

    out_root = args.out_dir.resolve()
    raw_root = out_root / "raw"
    chk_root = out_root / "checksums"
    man_root = out_root / "manifests"
    man_root.mkdir(parents=True, exist_ok=True)

    if not args.skip_exchange_info:
        print("Auditing live Binance USD-M /fapi/v1/exchangeInfo metadata...")
        info = audit_exchange_info(man_root / "exchange_info_audit.json")
        for sym, rec in info.items():
            print(f"  {sym}: type={rec['contractType']} underlying={rec['underlyingType']} tickSize={rec['tickSize']}")

    tasks: set[tuple[str, str, str]] = set()
    if args.preset in ("historical12", "all"):
        for month, _ in HISTORICAL_12_DATES:
            for sym in SYMBOLS:
                tasks.add(("1m", sym, month))
    if args.preset in ("extended29", "all"):
        for month, _ in EXTENDED_ARM1_DATES:
            for sym in SYMBOLS:
                tasks.add(("1m", sym, month))
        for sym in SYMBOLS:
            tasks.add(("15m", sym, "2026-07"))

    print(f"\nDownloading & SHA-256 verifying {len(tasks)} official Binance Vision monthly kline archives...")
    rec_map: dict[tuple[str, str, str], dict] = {}
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(download_monthly_zip, iv, sym, m, raw_root, chk_root): (iv, sym, m) for iv, sym, m in sorted(tasks)}
        for fut in as_completed(futs):
            rec = fut.result()
            rec_map[(rec["interval"], rec["symbol"], rec["month"])] = rec
            print(f"  [{rec['action']}] {rec['symbol']}-{rec['interval']}-{rec['month']}")

    frozen: dict[str, list[dict]] = {}
    if args.preset in ("historical12", "all"):
        entries = []
        for month, start_d in HISTORICAL_12_DATES:
            for sym in SYMBOLS:
                rec = rec_map[("1m", sym, month)]
                rows = parse_kline_zip(Path(rec["localPath"]))
                wid = f"HIST-{sym}-{month}-12H-1M"
                entries.append(freeze_window(
                    wid, sym, "1m", 60_000, rows, start_d, 720,
                    out_root / "windows" / "historical_12h" / f"{wid}.json",
                    Path(rec["localPath"]), rec["verifiedSha256"], out_root,
                ))
        frozen["historical_12h_1m"] = entries
        print(f"Frozen {len(entries)} historical 12-hour windows.")

    if args.preset in ("extended29", "all"):
        arm1 = []
        for month, start_d in EXTENDED_ARM1_DATES:
            for sym in SYMBOLS:
                rec = rec_map[("1m", sym, month)]
                rows = parse_kline_zip(Path(rec["localPath"]))
                wid = f"R8-ARM1-{sym}-{start_d}-48H-1M"
                arm1.append(freeze_window(
                    wid, sym, "1m", 60_000, rows, start_d, 2880,
                    out_root / "windows" / "arm1_1m_48h" / f"{wid}.json",
                    Path(rec["localPath"]), rec["verifiedSha256"], out_root,
                ))
        arm2 = []
        for sym in SYMBOLS:
            rec = rec_map[("15m", sym, "2026-07")]
            rows = parse_kline_zip(Path(rec["localPath"]))
            wid = f"R8-ARM2-{sym}-2026-07-30D-15M"
            arm2.append(freeze_window(
                wid, sym, "15m", 900_000, rows, "2026-07-01", 2880,
                out_root / "windows" / "arm2_15m_30d" / f"{wid}.json",
                Path(rec["localPath"]), rec["verifiedSha256"], out_root,
            ))
        rec_sc = rec_map[("1m", "BTCUSDT", "2026-07")]
        sc_rows = parse_kline_zip(Path(rec_sc["localPath"]))
        sc_entry = freeze_window(
            "R8-SCALING-BTCUSDT-2026-07-01-10000-1M", "BTCUSDT", "1m", 60_000, sc_rows, "2026-07-01", 10000,
            out_root / "windows" / "scaling_contiguous" / "R8-SCALING-BTCUSDT-2026-07-01-10000-1M.json",
            Path(rec_sc["localPath"]), rec_sc["verifiedSha256"], out_root,
        )
        frozen["arm1_1m_48h"] = arm1
        frozen["arm2_15m_30d"] = arm2
        frozen["scaling_contiguous"] = [sc_entry]
        print(f"Frozen {len(arm1)} Arm-1 windows, {len(arm2)} Arm-2 windows, and 1 contiguous 10,000-bar scaling window.")

    manifest_out = man_root / "downloaded_window_manifest.json"
    manifest_out.write_text(json.dumps({"generatedAtUtc": utc_now(), **frozen}, indent=2) + "\n", encoding="utf-8")
    print(f"Saved manifest -> {manifest_out}")


if __name__ == "__main__":
    main()
