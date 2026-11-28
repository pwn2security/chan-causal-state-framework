# Market Data Acquisition and Integrity Verification

Raw exchange OHLC data are **not redistributed** in this repository to respect Binance historical-data redistribution terms.

All empirical datasets analyzed in the manuscript—14 historical baseline windows and 29 extended-horizon, cross-frequency, and contiguous-scaling windows—are derived directly from official **Binance Data Vision** public historical archives (`https://data.binance.vision/`). Ready-to-run, cross-platform crawlers and deterministic aggregation scripts are provided in [`acquisition/`](acquisition/README.md).

## Dataset Overview & Manuscript Mapping

1. **Extended-Horizon, Cross-Frequency, and Contiguous Scaling Suite (29 windows, May–October 2026; Sections 3.2–3.3, Tables 3–5, Figures 4–5 & 8):**
   - Venue: **Binance USD-M Futures 24/7 perpetual contracts** (`BTCUSDT`, `ETHUSDT`, `XAUUSDT`, `SPYUSDT`), with official `/fapi/v1/exchangeInfo` `PRICE_FILTER.tickSize` archived in [`../manifests/exchange_info_tick_snapshot.json`](../manifests/exchange_info_tick_snapshot.json) (`0.10` BTCUSDT; `0.01` ETHUSDT, XAUUSDT, SPYUSDT).
   - Official archive patterns (each verified via its `.CHECKSUM` SHA-256 digest):
     - **Arm 1 & Arm 3** (24 independent 48-h 1-min windows across six separated months: `2026-05-19, 06-16, 07-21, 08-18, 09-15, 10-20`, Tue 00:00 → Thu 00:00 UTC, $N=2{,}880$) and the **contiguous 10,000-bar BTCUSDT scaling stream** (`2026-07-01`–`07-07`):
       `data/futures/um/monthly/klines/<SYMBOL>/1m/<SYMBOL>-1m-2026-<MM>.zip`
     - **Arm 2** (four contiguous 30-day 15-min zero-flat-bar windows, `2026-07-01`–`07-31`, $N=2{,}880$, $\mathrm{ZR}=0.00\%$):
       `data/futures/um/monthly/klines/<SYMBOL>/15m/<SYMBOL>-15m-2026-07.zip`
   - Automated retrieval, `.CHECKSUM` verification, and deterministic window freezing:
     ```bash
     python data/acquisition/download_binance_monthly_klines.py --preset extended29 --out-dir ./local_data/extended_validation
     ```

2. **Historical 12-Window Cross-Underlying Suite (June–August 2026, $N=720$ 1-min bars each; Section 3.1, Section 4.4, Table 6, Figures 6 & S2–S3):**
   - Official Binance USD-M Futures monthly 1-min archives (`2026-06, 07, 08`), selecting the first 720 finalized bars starting `00:00:00 UTC` on the second Monday (`2026-06-08`, `2026-07-13`, `2026-08-10`). Pass `--preset historical12` or `--preset all` to `download_binance_monthly_klines.py`.

3. **January 2025 `BTCUSDT` Baseline Windows (571 and 720 1-min bars; Section 3.1, Section 4.1, Figures 2–3, Figure 7, Supplementary Figure S1):**
   - Official Binance USD-M Futures daily trade archives (`data/futures/um/daily/trades/BTCUSDT/BTCUSDT-trades-2025-01-01.zip` and `2025-01-02.zip`).
   - Automated daily-trade crawler (`data/acquisition/download_binance_daily_trades.py`), monthly 1-second resampler (`data/acquisition/aggregate_trades_to_1s.py`), and exact 1-minute window aggregator (`experiments/aggregate_2025_trades_to_1m.py` with `--mode direct600k` for the 571-bar negative-case baseline and `--mode via1s` for the 720-bar initial-Pivot baseline).

## Verifying Local Window Integrity

Exact UTC boundaries, bar counts, venues, and canonical SHA-256 digests are recorded in [`window_manifest.json`](window_manifest.json) (14 historical baseline windows) and [`../manifests/extended_window_manifest.json`](../manifests/extended_window_manifest.json) (29 extended-horizon, cross-frequency, and contiguous scaling windows). Verify local windows via:

```bash
python data/verify_hashes.py --dir ./local_windows
```

All synthetic verification tests (`npm test`) run offline with zero external data dependencies.
