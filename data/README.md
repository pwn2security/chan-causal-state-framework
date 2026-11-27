# Market Data Acquisition and Integrity Verification

Raw exchange OHLC data are **not redistributed** in this repository to respect Binance historical-data redistribution terms.

All 14 empirical evaluation windows used in the paper are derived directly from official Binance Vision public historical archives (`https://data.binance.vision/`):

1. **Cross-underlying 12-window suite (`R4-*`, June--August 2026, 720 finalized 1-minute bars each)**:
   - Venue: **Binance USD-M Futures 24/7 perpetual contracts** (`BTCUSDT`, `ETHUSDT`, `XAUUSDT`, `SPYUSDT`).
   - Archive path pattern:
     `data/futures/um/monthly/klines/<SYMBOL>/1m/<SYMBOL>-1m-2026-<MM>.zip`
   - Fixed window selection rule: the first 720 finalized 1-minute bars starting at `00:00:00 UTC` on the second Monday of each month (`2026-06-08`, `2026-07-13`, `2026-08-10`), with zero gap filling or price adjustment.

2. **Primary BTCUSDT baseline windows (January 2025, 571 and 720 finalized 1-minute bars)**:
   - Venue: **Binance Spot (`BTCUSDT`)** public trade / 1-second kline archives (distinct from the 2026 USD-M perpetual futures suite; the 720-bar `2025-01-02` window also enters the five-window traceability and look-ahead study).
   - Archive path patterns:
     - `2025-01-01` (571 bars, tick-derived): `data/spot/daily/trades/BTCUSDT/BTCUSDT-trades-2025-01-01.zip`, aggregated into non-overlapping closed 1-minute UTC buckets `[t_0 + 60000*i, t_0 + 60000*i + 59999]` (`open` = first trade price, `high` = max, `low` = min, `close` = last trade price, zero gap filling) over `00:00:00`–`09:30:59.999 UTC`.
     - `2025-01-02` (720 bars, 1s-derived): `data/spot/daily/klines/BTCUSDT/1s/BTCUSDT-1s-2025-01-02.zip`, aggregated over 60 consecutive 1-second bars per closed 1-minute UTC bucket (`open` = first open, `high` = max high, `low` = min low, `close` = last close) over `00:00:00`–`11:59:59.999 UTC`.

## Expected Window JSON Schema

Each local window file `<windowId>.json` placed under `CT_WINDOWS_DIR` (default `./local_windows/`) follows the minimal closed-bar JSON schema consumed by all `experiments/` scripts:

```json
{
  "windowId": "R4-BTCUSDT-2026-06-FIXED-01",
  "bars": [
    {
      "index": 0,
      "startTime": 1780876800000,
      "endTime": 1780876859999,
      "open": 63159.5,
      "high": 63201.0,
      "low": 63140.2,
      "close": 63195.8
    }
  ]
}
```

Exact UTC boundaries, bar counts, venues, and canonical SHA-256 digests of the frozen input JSON files are recorded in [`window_manifest.json`](window_manifest.json).

## Verifying local files

Place downloaded/aggregated window JSON files in a local folder (e.g., `./local_windows/`) and run:

```bash
python data/verify_hashes.py --dir ./local_windows
```

All synthetic regression tests (`npm test`) run offline with zero external data dependencies.
