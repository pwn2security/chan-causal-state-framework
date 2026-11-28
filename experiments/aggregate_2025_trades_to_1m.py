"""Deterministic Binance USD-M Futures daily-trades -> 1-min OHLC aggregation recipe.

Reconstructs the two January 2025 BTCUSDT baseline windows from official Binance Data Vision
USD-M Futures daily trade archives:
  https://data.binance.vision/data/futures/um/daily/trades/BTCUSDT/BTCUSDT-trades-2025-01-01.zip
  https://data.binance.vision/data/futures/um/daily/trades/BTCUSDT/BTCUSDT-trades-2025-01-02.zip

Two documented aggregation modes matching window_manifest.json:
  1. --mode direct600k (2025-01-01, 571-bar negative-case baseline):
     Buckets the first 600,000 sequential trades directly into finalized 60,000 ms UTC bars,
     dropping the final partial minute bucket.
  2. --mode via1s (2025-01-02, 720-bar initial-Pivot baseline):
     First aggregates raw trades into 1-second OHLC buckets (matching monthly 1s archive),
     then deterministically rolls 60-second UTC windows into 720 finalized 1-minute bars
     starting at 2025-01-02T00:00:00.000Z.
"""
from __future__ import annotations

import argparse
import csv
import json
import zipfile
from pathlib import Path


def iter_trades(path: Path):
    """Yield (time_ms: int, price: float, qty: float) from Binance USD-M daily trades CSV or ZIP."""
    def _parse(fh):
        reader = csv.reader(fh)
        first = next(reader, None)
        if first is None:
            return
        # Handle optional header row: id,price,qty,quote_qty,time,is_buyer_maker
        if first[0].strip().lower() != "id":
            yield int(first[4]), float(first[1]), float(first[2])
        for row in reader:
            if len(row) >= 5:
                yield int(row[4]), float(row[1]), float(row[2])

    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path, "r") as zf:
            csv_name = next(n for n in zf.namelist() if n.endswith(".csv"))
            with zf.open(csv_name, "r") as raw:
                yield from _parse((line.decode("utf-8") for line in raw))
    else:
        with path.open("r", encoding="utf-8") as fh:
            yield from _parse(fh)


def bucket_ohlc(trades_iter, bucket_ms: int, max_trades: int | None = None):
    buckets: dict[int, list] = {}
    for idx, (ts_ms, price, qty) in enumerate(trades_iter):
        if max_trades is not None and idx >= max_trades:
            break
        b0 = (ts_ms // bucket_ms) * bucket_ms
        rec = buckets.get(b0)
        if rec is None:
            buckets[b0] = [price, price, price, price, qty, 1]
        else:
            if price > rec[1]:
                rec[1] = price
            if price < rec[2]:
                rec[2] = price
            rec[3] = price
            rec[4] += qty
            rec[5] += 1
    out = []
    for b0 in sorted(buckets):
        o, h, l, c, vol, cnt = buckets[b0]
        out.append({
            "startTime": b0,
            "endTime": b0 + bucket_ms - 1,
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": round(vol, 8),
            "tradeCount": cnt,
        })
    return out


def rollup_1s_to_1m(bars_1s: list[dict], limit: int = 720) -> list[dict]:
    buckets: dict[int, list] = {}
    for b in bars_1s:
        m0 = (int(b["startTime"]) // 60_000) * 60_000
        rec = buckets.get(m0)
        if rec is None:
            buckets[m0] = [b["open"], b["high"], b["low"], b["close"], b["volume"], b["tradeCount"]]
        else:
            rec[1] = max(rec[1], b["high"])
            rec[2] = min(rec[2], b["low"])
            rec[3] = b["close"]
            rec[4] += b["volume"]
            rec[5] += b["tradeCount"]
    out = []
    for idx, m0 in enumerate(sorted(buckets)[:limit]):
        o, h, l, c, vol, cnt = buckets[m0]
        out.append({
            "index": idx,
            "startTime": m0,
            "endTime": m0 + 59_999,
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": round(vol, 8),
            "tradeCount": cnt,
        })
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Deterministic Binance USD-M Futures daily-trades -> 1-min aggregator")
    ap.add_argument("--input", required=True, help="Path to BTCUSDT-trades-YYYY-MM-DD.zip or .csv")
    ap.add_argument("--mode", choices=["direct600k", "via1s"], required=True)
    ap.add_argument("--output", required=True, help="Output JSON path")
    ap.add_argument("--limit", type=int, default=720, help="Max 1-min bars for via1s mode (default 720)")
    args = ap.parse_args()

    src = Path(args.input)
    if args.mode == "direct600k":
        bars_1m = bucket_ohlc(iter_trades(src), bucket_ms=60_000, max_trades=600_000)
        # Drop trailing partial minute bucket
        bars_1m = bars_1m[:-1]
        for idx, b in enumerate(bars_1m):
            b["index"] = idx
    else:
        bars_1s = bucket_ohlc(iter_trades(src), bucket_ms=1_000)
        bars_1m = rollup_1s_to_1m(bars_1s, limit=args.limit)

    payload = {
        "schemaVersion": "CT-Deterministic-Trades-1M-v1.0",
        "sourceArchive": src.name,
        "venue": "Binance USD-M Futures (daily trades)",
        "mode": args.mode,
        "barCount": len(bars_1m),
        "bars": bars_1m,
    }
    Path(args.output).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[OK] Wrote {len(bars_1m)} finalized 1-min bars to {args.output}")


if __name__ == "__main__":
    main()
