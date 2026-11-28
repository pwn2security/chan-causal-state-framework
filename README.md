# Hierarchical Hybrid State-Space Framework for Chan Theory (`CT-Core-Parser-R1.0.4`)

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.24580630.svg)](https://doi.org/10.5281/zenodo.24580630)

Companion source code, formal rule contracts, offline zero-data verification suite, official Binance Data Vision crawlers and deterministic aggregation scripts, and reproducible econophysics benchmark scripts for:

> **A Hierarchical Hybrid State-Space Framework for Financial Market Structure Analysis Based on Chan Theory**
> Yuting Wang, Jun Zeng\*, Peng Cheng — *Physica A: Statistical Mechanics and its Applications* (`Release v2.0.0`)

---

## Manuscript-to-Artifact Crosswalk

Every empirical table, figure, and verification claim in the main article and Supplementary Material maps directly to a reproducible script and archived summary table below:

| Paper Location | Scientific Content | Reproducing Script(s) & Archived Outputs |
| :--- | :--- | :--- |
| **§2, Alg. 1, Supp. Alg. S1** | Causal five-layer discrete-time hybrid-state transducer ($K,F,B,S,Z$) & Snapshot v5 contract | Frozen `CT-Core-Parser-R1.0.4` (`src/ct-v5/`), `contracts/core-freeze-manifest-r1.0.4-v5.json`, `npm test` (`tests/run_synthetic_suite.mjs`) |
| **§3.1–3.2, Supp. S8** | Official Binance USD-M Futures daily-trade & monthly-kline crawlers, `.CHECKSUM` verification, `/fapi/v1/exchangeInfo` tick audit | `data/acquisition/download_binance_daily_trades.py`, `data/acquisition/aggregate_trades_to_1s.py`, `experiments/aggregate_2025_trades_to_1m.py`, `data/acquisition/download_binance_monthly_klines.py` |
| **§4.1, Table 2, Supp. S3–S4 & S13.5** | Causal invariance ($\mathrm{CR}=1, \mathrm{HRR}=0$), Markovian continuation, 64/64 equivalence gate, isolated 2-line `lifecycleEvents` patch | `npm test`, `experiments/equivalence_and_lifecycle_patch.mjs`, `manifests/results_summary/lifecycle_patch_verify.json` |
| **§4.1, Figs. 2–3, Supp. Fig. S1** | January 2025 `BTCUSDT` 720-bar initial-Pivot & 571-bar negative-case baseline reconstructions | `experiments/aggregate_2025_trades_to_1m.py`, `figures/generate_baseline_figures.py` |
| **§4.2, Table 3, Fig. 4, Supp. Tables S13.1–S13.3** | Dual-axis 6-model null ladder (5,180 paths across Arm 1 48-h 1-min, Arm 2 30-day 15-min zero-flat-bar, Arm 3 $m_B=4$, CBB/SBB sensitivity, FSS, and QMLE GARCH(1,1)) | `experiments/garch_qmle_fit.py`, `experiments/run_extended_real_and_lookahead.mjs`, `experiments/run_null_ensembles.mjs`, `experiments/null_surrogates.mjs`, `experiments/analyze_extended_tables.py`, `manifests/results_summary/table_arm*.csv` |
| **§4.3, Tables 4–5, Fig. 5, Supp. Table S13.4** | Extended four-clock exposure lag & look-ahead distortion across 29,424 events (with matched `TQ-GBM` mechanical control & HAC/non-overlapping tests) | `experiments/run_extended_real_and_lookahead.mjs`, `experiments/analyze_extended_tables.py`, `manifests/results_summary/table_four_clock_lookahead.csv` |
| **§4.4, Table 6, Figs. 6–7, Supp. Tables S12.4–S12.5** | 14-window cross-implementation correspondence & super-additive counterfactuals (`CF-1`–`CF-4`) vs. `chan.py` | `experiments/chanpy_internal_runner.mjs`, `experiments/chanpy_spacing_counterfactual.py`, `experiments/chanpy_variantB_runner.mjs`, `experiments/chanpy_joint_counterfactual.py`, `experiments/chanpy_matcher/` |
| **§4.5, Fig. 8, Supp. Tables S12.3 & S13.5** | Four-tier computational scaling: repeated 720-bar audit ablation vs. contiguous 10,000-bar real BTCUSDT stream & $40.1\times$ bit-exact incremental tail memoization | `experiments/scaling_audit_ablation.mjs`, `experiments/incremental_tail_sandbox.mjs`, `experiments/run_contiguous_fast_scaling.mjs`, `manifests/results_summary/table_contiguous_scaling_*.csv` |
| **Vector Figures 2–8 & Submission Verifier** | Pure-vector PDF figure renderers (TrueType embedded fonts, zero Type 3, zero raster) and automated LaTeX/bundle checker | `figures/generate_main_figures.py`, `figures/generate_baseline_figures.py`, `figures/verify_submission_bundle.py` |

> **Frozen Core Integrity Note:** Every file under `src/ct-v5/` remains **100% byte-identical** to the frozen `CT-Core-Parser-R1.0.4` release (`contracts/core-freeze-manifest-r1.0.4-v5.json`). Both the isolated two-line `lifecycleEvents` serialization patch verification and the fourth-tier bit-exact memoized incremental-tail engine execute strictly inside isolated Node.js VM sandboxes without modifying any frozen parser source file.

---

## Repository Structure

```text
├── src/
│   ├── models.js, market-core.js                 # Shared runtime primitives
│   └── ct-v5/                                    # Frozen CT-Core-Parser-R1.0.4 (Snapshot v5)
├── contracts/                                    # Versioned rule configs, schemas, comparator specs
├── tests/
│   └── run_synthetic_suite.mjs                   # Zero-data offline verification suite (npm test)
├── data/
│   ├── README.md                                 # Market data acquisition & provenance guide
│   ├── window_manifest.json                      # 14 historical baseline windows SHA-256 manifest
│   ├── verify_hashes.py                          # Local SHA-256 integrity verifier
│   └── acquisition/                              # Cross-platform Binance Vision crawlers & aggregators
│       ├── README.md                             # Step-by-step crawler & aggregation guide
│       ├── download_binance_daily_trades.py      # Official daily tick-trades crawler (.CHECKSUM verified)
│       ├── aggregate_trades_to_1s.py             # Streaming daily-trades -> monthly 1s OHLCV aggregator
│       └── download_binance_monthly_klines.py    # Official monthly klines crawler, exchangeInfo tick audit & window freezer
├── manifests/                                    # Protocol lock, exchangeInfo ticks, 29-window SHA-256 manifest & verified CSV/JSON tables
├── experiments/                                  # Portable simulation, statistical inference & scaling scripts (all relative/env paths)
├── figures/                                      # Pure-vector PDF figure renderers & submission bundle verifier
├── docs/
│   └── Supplementary_Material.pdf                # Companion Supplementary Material
├── CITATION.cff
├── LICENSE
└── package.json
```

---

## Quick Start (Zero External Data Required)

Requires **Node.js $\ge 20$** (validated on `v24.19.0`; zero npm dependencies):

```bash
npm test
```

Runs six deterministic offline verification checks covering the five-layer causal cascade, online prefix consistency ($\mathrm{CR}=1$), append-only archival non-revision ($\mathrm{HRR}=0$), future-only Snapshot v5 continuation ($\mathrm{RCR}=1$), Stroke-spacing sensitivity ($m_B=2$ vs. $4$), and bit-exact full-audit vs. audit-hooks-off equivalence.

---

## Reproducing the Full Empirical Benchmark

All Python scripts require `numpy` and `scipy` (`pandas` for monthly 1-second trade aggregation; `matplotlib` and `pymupdf` for figure rendering and PDF verification). Default directories are repository-relative (`./local_data/extended_validation` and `./results`) and can be overridden via `CT_DATA_ROOT` and `CT_RESULTS_DIR`:

```bash
# 1. Download official Binance Data Vision archives, verify .CHECKSUM digests, and freeze all 29 benchmark windows
python data/acquisition/download_binance_monthly_klines.py --preset extended29 --out-dir ./local_data/extended_validation

# 2. Fit variance-targeting QMLE GARCH(1,1) across all 28 extended windows (Arm 1 + Arm 2)
python experiments/garch_qmle_fit.py

# 3. Verify 8/8 full-audit SHA-256 equivalence gate & isolated 2-line lifecycleEvents patch (Table 2, Supp. S13.5)
node experiments/equivalence_and_lifecycle_patch.mjs

# 4. Run real windows (Arms 1-3), FSS, contiguous 10,000-bar scaling, TQ-GBM control & 29,424 four-clock events
node experiments/run_extended_real_and_lookahead.mjs
node experiments/run_contiguous_fast_scaling.mjs

# 5. Run dual-axis 6-model null ensembles (resumable JSONL; adjust --workers to CPU count)
node experiments/run_null_ensembles.mjs --arm arm2 --paths 25 --workers 8
node experiments/run_null_ensembles.mjs --arm arm3 --paths 10 --workers 8
node experiments/run_null_ensembles.mjs --arm arm1 --paths 25 --workers 8
node experiments/run_null_ensembles.mjs --arm cbb_sens --paths 10 --workers 8

# 6. Compute exact date-clustered Wilcoxon, Newey-West HAC, and binomial zero-mean baseline tables (Tables 3-5)
python experiments/analyze_extended_tables.py

# 7. Regenerate publication-grade pure-vector Figures 4, 5, 6, and 8 directly from archived CSV/JSON summaries
python figures/generate_main_figures.py
```

For the 14-window cross-implementation counterfactuals (Section 4.4, Table 6) against `Vespa314/chan.py` (frozen ZIP snapshot from `main` accessed 9 October 2026; file-tree inventory SHA-256 `6a33ea408e5e6071305845f7c64f5ef4677c6127d8f1a7757ab8411da82239d4`), see `experiments/chanpy_internal_runner.mjs`, `experiments/chanpy_spacing_counterfactual.py`, `experiments/chanpy_variantB_runner.mjs`, and `experiments/chanpy_joint_counterfactual.py`.

---

## License

Released under the [MIT License](LICENSE). Raw exchange market data are excluded from redistribution in accordance with Binance historical-data terms.
