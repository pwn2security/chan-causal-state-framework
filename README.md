# Hierarchical Hybrid State-Space Framework for Chan Theory (`CT-Core-Parser-R1.0.4`)

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.24580630.svg)](https://doi.org/10.5281/zenodo.24580630)

Companion code, frozen rule contracts, offline synthetic verification suite, and diagnostic scripts for:

> **A Hierarchical Hybrid State-Space Framework for Financial Market Structure Analysis Based on Chan Theory**
> Yuting Wang, Jun Zeng\*, Peng Cheng — *Physica A: Statistical Mechanics and its Applications* (submitted)

## Repository Structure

```text
├── docs/
│   └── Supplementary_Material.pdf  # Complete 26-page Supplementary Material (S1–S12, Tables S1.1–S12.5)
├── src/
│   ├── models.js, market-core.js   # Shared runtime primitives
│   └── ct-v5/                      # Frozen CT-Core-Parser-R1.0.4 (Snapshot v5) implementation
├── contracts/                      # Versioned rule configs, schema contracts, comparator specs
├── tests/
│   └── run_synthetic_suite.mjs     # Zero-data offline verification suite (CR, HRR, RCR, m_B=2 vs m_B=4)
├── experiments/                    # Reproducible diagnostic scripts (null models, ablations, look-ahead)
├── figures/                        # Vector figure generation & font/hash audit scripts
├── data/
│   ├── README.md                   # Official Binance Vision acquisition instructions (no raw data redistributed)
│   ├── window_manifest.json        # Exact UTC boundaries, bar counts & SHA-256 digests for all 14 windows
│   └── verify_hashes.py            # Local integrity checker against window_manifest.json
├── CITATION.cff
├── LICENSE
└── package.json
```

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
5. Microscopic Stroke-separation sensitivity (`minimumStrokeSeparation`: 2 vs 4).
6. Bit-for-bit structural equivalence between full-audit mode and audit-hooks-disabled mode.

## Reproducing Empirical Market Diagnostics

See [`data/README.md`](data/README.md) to acquire the 14 fixed 1-minute windows from official Binance Vision archives and verify their SHA-256 digests via `python data/verify_hashes.py`. Once verified, the scripts in `experiments/` reproduce (leaving the frozen `CT-Core-Parser-R1.0.4` core strictly unmodified):
- **Exp 1 (`exp1_null_model.mjs`, `exp1_null_model_stats.py`, `exp1_v22_discretization.mjs`, `exp1_v22_discretization_stats.py`, `exp1_v24_shuffled_microstructure.mjs`)**: Shuffled-return, continuous-precision 60-substep GBM, and tick-quantized 60-substep GBM null-model Monte Carlo benchmarks (12 windows $\times$ 50 paths $\times$ 3 nulls = 1,800 trajectories), plus flat-bar/equal-bound microstructure (including shuffled-return `Zero%`/`EqB%`) and calendar-date-grouped robustness checks (Table S12.1).
- **Exp 2 (`exp2_hashing_ablation.mjs`)**: Controlled three-tier audit-overhead scaling ablation ($N = 120$ to $5{,}000$) verifying bit-for-bit identical sealed $K/F/B/S/Z$ outputs (Table S12.3).
- **Exp 3 (`exp3_internal_runner.mjs`, `exp3_r7_spacing_counterfactual.py`, `exp3_v22_varB_runner.mjs`, `exp3_v22_cf4_match.py`)**: Cross-implementation Stroke-spacing (`CF-1`–`CF-3`) and combined spacing + Variant-B endpoint-guard (`CF-4`: $m_B=4$ + $G_{\mathrm{extreme}}$ off; plus `CF-4b`/`CF-4c`) counterfactuals against `Vespa314/chan.py` across 14 windows (Tables S12.4–S12.5).
- **Exp 4 (`exp4_downstream_lookahead.py`, `exp4_v22_robustness.py`, `exp4_v24_per_window_standardized.py`)**: Downstream look-ahead distortion across $t_{\mathrm{event}}$, $t_{\mathrm{native}}$, and $t_{\mathrm{emit}}$ over horizons $h \in \{5, 15, 30, 60\}$ min, supplemented with same-family i.i.d. paired $t$-tests, lag-1 autocorrelation ($\hat{\rho}_1$), within-window Bartlett-kernel Newey–West HAC $t$-tests, strictly non-overlapping subsamples, pre-emission pullback decomposition, and per-window Brownian-diffusion-standardized ($z_h$) robustness checks (Table S12.2).

## License

Released under the [MIT License](LICENSE). Raw exchange market data are excluded from redistribution.
