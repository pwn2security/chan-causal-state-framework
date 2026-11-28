"""
Fit Variance-Targeting QMLE GARCH(1,1) on all 24 Arm-1 (1m, N=2880) and 4 Arm-2 (15m, N=2880) windows:
  sigma_t^2 = sigma_hat^2 * (1 - alpha - beta) + alpha * r_{t-1}^2 + beta * sigma_{t-1}^2
  subject to alpha >= 0, beta >= 0, alpha + beta <= 0.99.
Outputs garch_qmle_fit_log.json for deterministic simulation in Node.js workers.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

REPO_ROOT = Path(__file__).resolve().parent.parent
R8_ROOT = Path(os.environ.get("CT_DATA_ROOT", str(REPO_ROOT / "local_data" / "extended_validation")))
OUT_DIR = Path(os.environ.get("CT_RESULTS_DIR", str(REPO_ROOT / "results")))


def fit_vt_garch11(closes: np.ndarray) -> dict:
    rets = np.diff(np.log(closes))
    mu = float(np.mean(rets))
    eps = rets - mu
    var_uncond = float(np.var(eps, ddof=1))
    sigma_uncond = math.sqrt(max(var_uncond, 1e-16))
    eps2 = eps * eps
    n = len(eps2)

    # Gaussian QMLE negative log-likelihood with variance targeting
    def neg_ll(params):
        a, b = params
        if a < 0.0 or b < 0.0 or (a + b) > 0.99:
            return 1e18
        omega = var_uncond * (1.0 - a - b)
        s2 = var_uncond
        ll = 0.0
        for t in range(n):
            if s2 <= 1e-20:
                return 1e18
            ll += math.log(s2) + eps2[t] / s2
            s2 = omega + a * eps2[t] + b * s2
        return 0.5 * ll

    # Multi-start grid to avoid local minima
    starts = [
        (0.05, 0.90),
        (0.08, 0.88),
        (0.12, 0.82),
        (0.03, 0.94),
        (0.15, 0.70),
        (0.01, 0.50),
    ]
    best_res = None
    best_val = float("inf")
    cons = [{"type": "ineq", "fun": lambda p: 0.99 - p[0] - p[1]}]
    bounds = [(0.0, 0.99), (0.0, 0.99)]
    for x0 in starts:
        res = minimize(neg_ll, x0, method="SLSQP", bounds=bounds, constraints=cons,
                       options={"maxiter": 300, "ftol": 1e-10})
        if res.fun < best_val:
            best_val = float(res.fun)
            best_res = res

    a_hat = float(max(0.0, min(0.99, best_res.x[0])))
    b_hat = float(max(0.0, min(0.99 - a_hat, best_res.x[1])))
    # Also evaluate constant-variance (a=0, b=0) LL for likelihood-ratio diagnostics
    ll_const = -neg_ll((0.0, 0.0))
    ll_garch = -neg_ll((a_hat, b_hat))
    lr_stat = 2.0 * max(0.0, ll_garch - ll_const)
    boundary_degen = a_hat < 1e-4

    # Diagnostic lag-1 autocorrelation of squared returns & absolute returns
    abs_r = np.abs(eps)
    ac1_abs = float(np.corrcoef(abs_r[:-1], abs_r[1:])[0, 1]) if n > 2 else 0.0
    ac1_sq = float(np.corrcoef(eps2[:-1], eps2[1:])[0, 1]) if n > 2 else 0.0
    kurt = float(np.mean((eps / sigma_uncond) ** 4))

    return {
        "nReturns": int(n),
        "muLog": mu,
        "sigmaUncond": sigma_uncond,
        "varUncond": var_uncond,
        "alpha": a_hat,
        "beta": b_hat,
        "persistence": a_hat + b_hat,
        "omega": var_uncond * (1.0 - a_hat - b_hat),
        "llGarch": ll_garch,
        "llConst": ll_const,
        "lrStat": lr_stat,
        "converged": bool(best_res.success),
        "boundaryDegenerateAlphaLt1e4": boundary_degen,
        "ac1AbsRet": ac1_abs,
        "ac1SqRet": ac1_sq,
        "excessKurtosis": kurt - 3.0,
    }


def main():
    ap = argparse.ArgumentParser(description="Fit variance-targeting QMLE GARCH(1,1) across all 28 extended windows.")
    ap.add_argument("--data-root", type=Path, default=R8_ROOT)
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = ap.parse_args()
    data_root = args.data_root.resolve()
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = data_root / "manifests" / "extended_window_manifest.json"
    if not manifest_path.exists():
        manifest_path = REPO_ROOT / "manifests" / "extended_window_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    out = {
        "protocolId": "CT-R8-ExtendedHorizon-CrossFreq-Null-v1.0.0",
        "generatedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": "Variance-Targeting QMLE GARCH(1,1), alpha>=0, beta>=0, alpha+beta<=0.99",
        "fits": {},
    }
    for arm_key in ["arm1_1m_48h", "arm2_15m_30d"]:
        print(f"\n=== FITTING {arm_key} ===")
        for entry in manifest[arm_key]:
            wid = entry["windowId"]
            fp = Path(entry["filePath"])
            if not fp.is_absolute():
                fp = data_root / fp
            data = json.loads(fp.read_text(encoding="utf-8"))
            closes = np.array([b["close"] for b in data["bars"]], dtype=np.float64)
            fit = fit_vt_garch11(closes)
            fit["symbol"] = entry["symbol"]
            fit["interval"] = entry["interval"]
            fit["tickSize"] = entry["tickSize"]
            fit["arm"] = arm_key
            out["fits"][wid] = fit
            flag = " [BOUNDARY]" if fit["boundaryDegenerateAlphaLt1e4"] else ""
            print(f"  {wid}: sig={fit['sigmaUncond']*1e4:5.2f}bps a={fit['alpha']:.4f} b={fit['beta']:.4f} "
                  f"a+b={fit['persistence']:.4f} LR={fit['lrStat']:6.1f} kurt={fit['excessKurtosis']:5.1f} "
                  f"ac1|r|={fit['ac1AbsRet']:.3f}{flag}")

    out_path = out_dir / "garch_qmle_fit_log.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"\nSaved {out_path}")


if __name__ == "__main__":
    main()
