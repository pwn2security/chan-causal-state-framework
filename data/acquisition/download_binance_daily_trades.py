"""Multi-threaded official Binance Data Vision USD-M Futures daily-trades crawler.

Downloads and SHA-256 verifies official daily tick-level trade archives from:
  https://data.binance.vision/data/futures/um/daily/trades/<SYMBOL>/<SYMBOL>-trades-<YYYY-MM-DD>.zip

Used to retrieve the raw January 2025 BTCUSDT daily trade files from which the
571-bar negative-case baseline (2025-01-01) and 720-bar initial-Pivot baseline
(2025-01-02) in Section 3.1, Figures 2-3, Figure 7, and Supplementary Figure S1
are deterministically reconstructed.

Usage example:
  python data/acquisition/download_binance_daily_trades.py \
      --symbol BTCUSDT --start-date 2025-01-01 --end-date 2025-01-02 \
      --out-dir ./local_data/btcusdt_2025_trades
"""
from __future__ import annotations

import argparse
import hashlib
import os
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

BASE_URL = "https://data.binance.vision/data/futures/um/daily/trades"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def http_get_bytes(url: str, retries: int = 5, timeout: int = 60) -> bytes | None:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ChanFramework-DataCrawler/2.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status == 200:
                    return resp.read()
                raise RuntimeError(f"HTTP {resp.status} for {url}")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            last_err = exc
            time.sleep(min(2 ** attempt, 16))
        except Exception as exc:
            last_err = exc
            time.sleep(min(2 ** attempt, 16))
    raise RuntimeError(f"Failed to download {url}: {last_err}")


def iter_dates(start: date, end: date) -> list[date]:
    days: list[date] = []
    cur = start
    while cur <= end:
        days.append(cur)
        cur += timedelta(days=1)
    return days


def download_day(symbol: str, day: date, out_dir: Path, keep_zip: bool, verify_checksum: bool) -> str:
    day_str = day.strftime("%Y-%m-%d")
    zip_name = f"{symbol}-trades-{day_str}.zip"
    url = f"{BASE_URL}/{symbol}/{zip_name}"
    zip_path = out_dir / zip_name
    csv_path = out_dir / f"{symbol}-trades-{day_str}.csv"

    if csv_path.exists() and not keep_zip:
        return f"[{day_str}] SKIP (CSV already present)"

    official_sha: str | None = None
    if verify_checksum:
        chk_bytes = http_get_bytes(url + ".CHECKSUM", timeout=30)
        if chk_bytes is None:
            return f"[{day_str}] NOT_FOUND (404)"
        official_sha = chk_bytes.decode("utf-8").strip().split()[0].lower()
        (out_dir / f"{zip_name}.CHECKSUM").write_bytes(chk_bytes)

    if zip_path.exists() and official_sha and sha256_file(zip_path) == official_sha:
        status = "CACHED_SHA_VERIFIED"
    else:
        payload = http_get_bytes(url, timeout=180)
        if payload is None:
            return f"[{day_str}] NOT_FOUND (404)"
        if official_sha:
            got_sha = hashlib.sha256(payload).hexdigest()
            if got_sha != official_sha:
                raise RuntimeError(f"[{day_str}] CHECKSUM_MISMATCH expected={official_sha} got={got_sha}")
        tmp = zip_path.with_suffix(".zip.partial")
        tmp.write_bytes(payload)
        tmp.replace(zip_path)
        status = "DOWNLOADED_VERIFIED" if official_sha else "DOWNLOADED"

    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(out_dir)

    if not keep_zip and zip_path.exists():
        os.remove(zip_path)

    return f"[{day_str}] {status} -> extracted {csv_path.name}"


def main() -> None:
    ap = argparse.ArgumentParser(description="Download official Binance USD-M Futures daily trade archives.")
    ap.add_argument("--symbol", default="BTCUSDT", help="Binance USD-M contract symbol (default: BTCUSDT)")
    ap.add_argument("--start-date", default="2025-01-01", help="Inclusive UTC start date YYYY-MM-DD")
    ap.add_argument("--end-date", default="2025-01-02", help="Inclusive UTC end date YYYY-MM-DD")
    ap.add_argument("--out-dir", type=Path, default=Path("./local_data/daily_trades"), help="Output directory")
    ap.add_argument("--workers", type=int, default=4, help="Concurrent download threads (default: 4)")
    ap.add_argument("--keep-zip", action="store_true", help="Keep original .zip archives after extraction")
    ap.add_argument("--no-checksum", action="store_true", help="Skip .CHECKSUM SHA-256 verification")
    args = ap.parse_args()

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    start_d = date.fromisoformat(args.start_date)
    end_d = date.fromisoformat(args.end_date)
    days = iter_dates(start_d, end_d)

    print(f"Downloading {args.symbol} USD-M daily trades ({args.start_date} to {args.end_date}, {len(days)} days) -> {out_dir}")
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {
            pool.submit(download_day, args.symbol, d, out_dir, args.keep_zip, not args.no_checksum): d
            for d in days
        }
        for fut in as_completed(futs):
            print(" ", fut.result())
    print("Completed daily trade archive retrieval.")


if __name__ == "__main__":
    main()
