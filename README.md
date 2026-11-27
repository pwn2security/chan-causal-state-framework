# Hierarchical Hybrid State-Space Framework for Chan Theory (`CT-Core-Parser-R1.0.4`)

Companion code, frozen rule contracts, offline synthetic verification suite, and diagnostic scripts for:

> **A Hierarchical Hybrid State-Space Framework for Financial Market Structure Analysis Based on Chan Theory**
> Yuting Wang, Jun Zeng\*, Peng Cheng — *Physica A: Statistical Mechanics and its Applications* (submitted)

## Repository Structure

```text
├── src/
│   ├── models.js, market-core.js   # Shared runtime primitives
│   └── ct-v5/                      # Frozen CT-Core-Parser-R1.0.4 (Snapshot v5) implementation
├── contracts/                      # Versioned rule configs, schema contracts, comparator specs
├── tests/
│   └── run_synthetic_suite.mjs     # Zero-data offline verification suite (CR, HRR, RCR, m=2 vs m=4)
├── experiments/                    # Reproducible Route B diagnostic scripts (null models, ablations, look-ahead)
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

See [`data/README.md`](data/README.md) to acquire the 14 fixed 1-minute windows from official Binance Vision archives and verify their SHA-256 digests via `python data/verify_hashes.py`. Once verified, the scripts in `experiments/` reproduce:
- **Exp 1**: Shuffled-return and 60-substep GBM null-model Monte Carlo benchmarks (12 windows $\times$ 50 paths $\times$ 2 nulls).
- **Exp 2**: Controlled three-tier audit-overhead scaling ablation ($N = 120$ to $5{,}000$).
- **Exp 3**: Cross-implementation Stroke-spacing counterfactual against `Vespa314/chan.py` across 14 windows.
- **Exp 4**: Downstream look-ahead distortion across $t_{\mathrm{event}}$, $t_{\mathrm{native}}$, and $t_{\mathrm{emit}}$ over horizons $h \in \{5, 15, 30, 60\}$ min.

## License

Released under the [MIT License](LICENSE). Raw exchange market data are excluded from redistribution.
