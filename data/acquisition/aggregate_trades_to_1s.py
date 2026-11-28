"""Streaming daily-trades -> monthly 1-second OHLCV aggregator.

Converts extracted Binance USD-M Futures daily trade CSV files
(`<SYMBOL>-trades-YYYY-MM-DD.csv`) into monthly 1-second OHLCV CSV files
(`<SYMBOL>-1s-YYYY-MM.csv`) in chronological order with bounded memory usage.

Empty 1-second bins (seconds with zero executed trades) are omitted without
forward-filling or synthetic interpolation, matching the strict missing-bar
policy described in Section 3.1 of the manuscript.

Usage example:
  python data/acquisition/aggregate_trades_to_1s.py \
      --in-dir ./local_data/btcusdt_2025_trades \
      --out-dir ./local_data/btcusdt_2025_1s \
      --symbol BTCUSDT
"""
from __future__ import annotations

import argparse
import gc
from pathlib import Path

import pandas as pd


def main() -> None:
    ap = argparse.ArgumentParser(description="Aggregate Binance USD-M daily trade CSVs into monthly 1-second OHLCV bars.")
    ap.add_argument("--in-dir", type=Path, required=True, help="Directory containing <SYMBOL>-trades-YYYY-MM-DD.csv files")
    ap.add_argument("--out-dir", type=Path, required=True, help="Output directory for monthly <SYMBOL>-1s-YYYY-MM.csv files")
    ap.add_argument("--symbol", default="BTCUSDT", help="Contract symbol prefix (default: BTCUSDT)")
    args = ap.parse_args()

    in_dir = args.in_dir.resolve()
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(in_dir.glob(f"{args.symbol}-trades-*.csv"))
    if not files:
        raise SystemExit(f"No {args.symbol}-trades-*.csv files found in {in_dir}")

    print(f"Found {len(files)} daily trade CSV files in {in_dir}.")
    current_month: str | None = None
    first_of_month = True

    for idx, csv_path in enumerate(files, start=1):
        parts = csv_path.stem.split("-")
        if len(parts) < 5:
            print(f"  [SKIP] Unexpected filename format: {csv_path.name}")
            continue
        file_month = f"{parts[2]}-{parts[3]}"
        out_file = out_dir / f"{args.symbol}-1s-{file_month}.csv"

        if file_month != current_month:
            current_month = file_month
            first_of_month = True
            if out_file.exists():
                out_file.unlink()
            print(f"\n=== Processing month {current_month} -> {out_file.name} ===")

        print(f"  [{idx}/{len(files)}] {csv_path.name}")
        df = pd.read_csv(csv_path, usecols=["price", "qty", "quote_qty", "time"])
        df["datetime"] = pd.to_datetime(df["time"], unit="ms", utc=True)
        df.set_index("datetime", inplace=True)

        kline = df.resample("1s").agg({
            "price": ["first", "max", "min", "last"],
            "qty": "sum",
            "quote_qty": "sum",
        })
        kline.columns = ["open", "high", "low", "close", "volume", "quote_volume"]
        kline.dropna(inplace=True)

        kline.to_csv(out_file, mode="a", header=first_of_month)
        first_of_month = False

        del df, kline
        gc.collect()

    print(f"\nCompleted monthly 1-second OHLCV aggregation in {out_dir}.")


if __name__ == "__main__":
    main()
