# Official Binance Data Vision Acquisition & Aggregation Suite

To respect Binance historical-data redistribution terms, raw exchange market files are **not redistributed** inside this repository. Instead, this directory provides clean, cross-platform Python crawlers and deterministic aggregation scripts that retrieve every empirical dataset used in the paper directly from official **Binance Data Vision** public historical archives (`https://data.binance.vision/`) and verify every download against official `.CHECKSUM` SHA-256 digests.

No API keys or authentication credentials are required. Missing bars are never forward-filled or synthetically interpolated.

---

## Script Inventory & Paper Mapping

| Script | Data Source & Official URL Pattern | Manuscript Coverage |
| :--- | :--- | :--- |
| `download_binance_daily_trades.py` | Official USD-M Futures daily trades:<br>`data/futures/um/daily/trades/<SYMBOL>/<SYMBOL>-trades-<YYYY-MM-DD>.zip` | Raw tick inputs for the two January 2025 `BTCUSDT` baseline windows (§3.1, §4.1, Figs. 2–3, Fig. 7, Supplementary Fig. S1) |
| `aggregate_trades_to_1s.py` | Local extracted daily trade CSVs (`<SYMBOL>-trades-YYYY-MM-DD.csv`) | Monthly streaming 1-second OHLCV resampler (zero forward-filling of inactive seconds) |
| `../../experiments/aggregate_2025_trades_to_1m.py` | Raw `BTCUSDT-trades-2025-01-01.zip` and `2025-01-02.zip` | Deterministically builds the exact 571-bar negative-case baseline (`--mode direct600k`) and 720-bar initial-Pivot baseline (`--mode via1s`) |
| `download_binance_monthly_klines.py` | Official USD-M Futures monthly klines + live `/fapi/v1/exchangeInfo`:<br>`data/futures/um/monthly/klines/<SYMBOL>/<INTERVAL>/<SYMBOL>-<INTERVAL>-<YYYY-MM>.zip` | Retrieves, `.CHECKSUM`-verifies, audits tick sizes (`0.10` BTCUSDT; `0.01` ETHUSDT, XAUUSDT, SPYUSDT), and freezes: (i) the 12 historical 12-h windows (§3.1, §4.4, Table 6, Figs. 6 & S2–S3); (ii) Arm 1 & Arm 3 (24 × 48-h 1-min windows across 6 months, §3.2, Tables 3–5, Figs. 4–5); (iii) Arm 2 (4 × 30-day 15-min zero-flat-bar windows); and (iv) the contiguous 10,000-bar BTCUSDT scaling stream (§4.5, Fig. 8) |

---

## Step-by-Step Reproduction Commands

### 1. Extended-Horizon, Cross-Frequency, and Contiguous Scaling Windows (29 Windows)

Downloads all 24 one-minute monthly archives (`2026-05` through `2026-10`) and 4 fifteen-minute monthly archives (`2026-07`), checks official `.CHECKSUM` SHA-256 hashes, verifies zero missing bars and OHLC consistency, and freezes all 29 benchmark windows:

```bash
python data/acquisition/download_binance_monthly_klines.py \
  --preset extended29 \
  --out-dir ./local_data/extended_validation
```

To also freeze the 12 historical 12-hour cross-underlying windows (June–August 2026, second Monday 00:00–12:00 UTC) used in the 14-window `chan.py` counterfactual comparison (Section 4.4, Table 6), pass `--preset all`.

### 2. January 2025 `BTCUSDT` Baseline Windows (571-bar & 720-bar)

```bash
# Step A: Download & checksum-verify raw January 1-2, 2025 daily trade archives
python data/acquisition/download_binance_daily_trades.py \
  --symbol BTCUSDT --start-date 2025-01-01 --end-date 2025-01-02 \
  --out-dir ./local_data/btcusdt_2025_trades --keep-zip

# Step B (Optional): Build monthly 1-second OHLCV archive from extracted daily trade CSVs
python data/acquisition/aggregate_trades_to_1s.py \
  --in-dir ./local_data/btcusdt_2025_trades \
  --out-dir ./local_data/btcusdt_2025_1s --symbol BTCUSDT

# Step C: Deterministically reconstruct the exact 571-bar and 720-bar 1-min baseline windows
python experiments/aggregate_2025_trades_to_1m.py \
  --input ./local_data/btcusdt_2025_trades/BTCUSDT-trades-2025-01-01.zip \
  --mode direct600k \
  --output ./local_data/btcusdt_2025_1m/BTCUSDT-2025-01-01-tick-derived-571.json

python experiments/aggregate_2025_trades_to_1m.py \
  --input ./local_data/btcusdt_2025_trades/BTCUSDT-trades-2025-01-02.zip \
  --mode via1s --limit 720 \
  --output ./local_data/btcusdt_2025_1m/BTCUSDT-2025-01-02-1s-derived-720.json
```

### 3. Cryptographic Integrity Check

Compare local frozen files against the exact canonical SHA-256 digests archived in:
- [`../window_manifest.json`](../window_manifest.json) (14 historical baseline windows)
- [`../../manifests/extended_window_manifest.json`](../../manifests/extended_window_manifest.json) (29 extended-horizon, cross-frequency, and contiguous scaling windows)

```bash
python data/verify_hashes.py --dir ./local_data/historical_windows
```
