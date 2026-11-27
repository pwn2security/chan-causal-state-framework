# Market Data Acquisition and Integrity Verification

Raw exchange OHLC data are **not redistributed** in this repository to respect Binance historical-data redistribution terms.

All 14 empirical evaluation windows used in the paper are derived directly from official Binance Vision public historical archives (`https://data.binance.vision/`):

1. **Cross-underlying 12-window suite (`R4-*`, June--August 2026, 720 finalized 1-minute bars each)**:
   - Venue: Binance USD-M Futures 24/7 perpetual contracts (`BTCUSDT`, `ETHUSDT`, `XAUUSDT`, `SPYUSDT`).
   - Archive path pattern: `data/futures/um/monthly/klines/<SYMBOL>/1m/<SYMBOL>-1m-2026-<MM>.zip`
   - Fixed window selection rule: the first 720 finalized 1-minute bars starting at `00:00:00 UTC` on the second Monday of each month, with zero gap filling or adjustment.
2. **Primary BTCUSDT baseline windows (January 2025, 571 and 720 finalized 1-minute bars)**:
   - Derived from official Binance Vision BTCUSDT trade/1s archives for `2025-01-01` and `2025-01-02`.

Exact UTC boundaries, row counts, and SHA-256 digests are recorded in [`window_manifest.json`](window_manifest.json).

## Verifying local files

Place downloaded/sliced window files in a local folder (e.g., `./local_windows/`) and run:

```bash
python data/verify_hashes.py --dir ./local_windows
```

All synthetic regression tests (`npm test`) run offline with zero external data dependencies.
