# Hierarchical Hybrid State-Space Framework for Chan Theory (`CT-Core-Parser-R1.0.4`)

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.24580630.svg)](https://doi.org/10.5281/zenodo.24580630)

Companion code, frozen rule contracts, offline synthetic verification suite, and reproducible diagnostic scripts for:

> **A Hierarchical Hybrid State-Space Framework for Financial Market Structure Analysis Based on Chan Theory**
> Yuting Wang, Jun Zeng\*, Peng Cheng — *Physica A: Statistical Mechanics and its Applications* (submitted)

## Repository Structure

```text
├── docs/
│   └── Supplementary_Material.pdf   # Complete 26-page Supplementary Material (S1–S12, Tables S1.1–S12.5)
├── src/
│   ├── models.js, market-core.js    # Shared runtime primitives
│   └── ct-v5/                       # Frozen CT-Core-Parser-R1.0.4 (Snapshot v5) implementation
├── contracts/                       # Versioned rule configs, schema contracts, comparator specs
├── tests/
│   └── run_synthetic_suite.mjs      # Zero-data offline verification suite (CR, HRR, RCR, m_B=2 vs m_B=4)
├── experiments/                     # End-to-end diagnostic scripts (Exp 1–4)
│   ├── r7_adapter/                  # Unmodified R7 global one-to-one matcher & sanitized semantic mapping
│   └── exp4_four_clock_replay.mjs   # Five-window synchronous four-clock sealed-boundary replay generator
├── figures/                         # Reference vector-figure rendering & LaTeX bundle audit scripts
├── data/
│   ├── README.md                    # Official Binance Vision acquisition & JSON schema instructions
│   ├── window_manifest.json         # Exact UTC boundaries, venues, bar counts & SHA-256 digests (14 windows)
│   └── verify_hashes.py             # Local integrity checker against window_manifest.json
├── CITATION.cff
├── LICENSE
└── package.json
```

> **Frozen Core Integrity Note:** Files under `src/ct-v5/` are byte-frozen to match the SHA-256 manifest in `contracts/core-freeze-manifest-r1.0.4-v5.json`. Two comment/metadata strings in `src/ct-v5/normalized-k.js` retain the historical internal engineering label `"WorkBuddy"`; these comments are left unmodified intentionally so cryptographic core-freeze hashes remain bit-for-bit valid.

## Quick Start (Zero External Data Required)

Requires **Node.js $\ge$ 20** (validated on `v24.19.0`; zero npm dependencies):

```bash
npm test
# or directly:
node tests/run_synthetic_suite.mjs
```

This runs six offline verification checks on deterministic synthetic OHLC streams:
1. Deterministic five-layer causal cascade ($K \to F \to B \to S \to Z$) and causal clock ordering ($t_{\mathrm{event}} \le t_{\mathrm{confirm}}$).
2. Online prefix consistency ($\mathrm{CR} = 1.0$) against fresh prefix replays.
3. Append-only historical publication non-revision ($\mathrm{HRR} = 0.0$) under observed, strong-up, and strong-down future suffixes.
4. Future-only Snapshot v5 checkpoint restart continuity ($\mathrm{RCR} = 1.0$) with zero pre-checkpoint raw-bar replay.
5. Microscopic Stroke-separation sensitivity (`minimumStrokeSeparation`: $m_B=2$ vs $m_B=4$).
6. Bit-for-bit structural equivalence between full-audit mode and audit-hooks-disabled mode.

## Reproducing Empirical Market Diagnostics (Exp 1–4)

See [`data/README.md`](data/README.md) to acquire the 14 fixed 1-minute windows from official Binance Vision archives (2 January 2025 Spot/Trades & 1s-derived BTCUSDT baseline windows + 12 June–August 2026 USD-M perpetual futures windows) and verify their SHA-256 digests via `python data/verify_hashes.py --dir ./local_windows`.

All diagnostic scripts are cross-platform and support environment overrides (`CT_WINDOWS_DIR`, `CT_RESULTS_DIR`, `CT_FOUR_CLOCK_DIR`, `CT_CHANPY_ROOT`, `CT_R7_ADAPTER_DIR`, `CT_MANUSCRIPT_DIR`) while leaving the frozen `CT-Core-Parser-R1.0.4` core strictly unmodified. Python scripts require `numpy` and `scipy`:

- **Exp 1 — Null-model Monte Carlo, tick discretization & shuffled microstructure (Table 7, Table S12.1)**:
  ```bash
  node experiments/exp1_null_model.mjs
  python experiments/exp1_null_model_stats.py
  node experiments/exp1_v22_discretization.mjs
  python experiments/exp1_v22_discretization_stats.py
  node experiments/exp1_v24_shuffled_microstructure.mjs
  ```
- **Exp 2 — Controlled three-tier audit-overhead scaling ablation (Figure 7, Table S12.3)**:
  ```bash
  node experiments/exp2_hashing_ablation.mjs
  ```
- **Exp 3 — 14-window cross-implementation counterfactuals vs. `Vespa314/chan.py` (Tables 10–11, Tables S12.4–S12.5)**:
  Clone `https://github.com/Vespa314/chan.py` (reference commit `429d6ed`) into `./chan.py-main` (or set `CT_CHANPY_ROOT`), verify the bundled unmodified R7 matcher via `python experiments/r7_adapter/matching.py`, then run:
  ```bash
  node experiments/exp3_internal_runner.mjs
  python experiments/exp3_r7_spacing_counterfactual.py
  node experiments/exp3_v22_varB_runner.mjs
  python experiments/exp3_v22_cf4_match.py
  ```
- **Exp 4 — Five-window four-clock replay & downstream look-ahead distortion (Table 13–14, Table S12.2)**:
  ```bash
  node experiments/exp4_four_clock_replay.mjs
  python experiments/exp4_downstream_lookahead.py
  python experiments/exp4_v22_robustness.py
  python experiments/exp4_v24_per_window_standardized.py
  ```

### Note on `figures/` Reference Scripts

Scripts under `figures/` (`redraw_physicaA_figures.py` and `verify_physicaA_bundle.py`, requiring `matplotlib` / `pymupdf`) are reference scripts used to render the manuscript's vector PDFs and audit the LaTeX submission bundle against local manuscript directories (`CT_MANUSCRIPT_DIR`, `CT_ARCHIVE_DIR`), which are not distributed inside this code repository.

## License

Released under the [MIT License](LICENSE). Raw exchange market data are excluded from redistribution.
