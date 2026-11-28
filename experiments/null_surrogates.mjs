/**
 * Shared deterministic surrogate generators for CT-R8-ExtendedHorizon-CrossFreq-Null-v1.0.0.
 * Zero external dependencies; exact reproducible mulberry32 PRNG keyed by BASE_SEED + offsets.
 *
 * Generators:
 *   - shuffled_L1 : Permutes 4-tuple relative log-ratios (gap, body, upWick, dnWick), exact flat-bar preservation.
 *   - cbb_L       : Circular Block Bootstrap over 4-tuple log-ratios with fixed block length L (default L=30; sensitivity L=15, 60).
 *   - sbb_L30     : Politis-Romano Stationary Block Bootstrap with geometric block length mean L=30.
 *   - cont_gbm    : Continuous-precision 60-substep GBM matched to empirical (mu_log, sigma).
 *   - tq_gbm      : Tick-quantized 60-substep GBM rounded to official exchangeInfo tickSize.
 *   - tq_garch    : Tick-quantized 60-substep Variance-Targeting GARCH(1,1) with 200-bar burn-in.
 */
import crypto from 'node:crypto';

export const BASE_SEED = 20261201;
export const MODEL_OFFSETS = Object.freeze({
  shuffled_L1: 10007,
  cbb_L30: 20011,
  cbb_L15: 20023,
  cbb_L60: 20047,
  sbb_L30: 20063,
  cont_gbm: 30013,
  tq_gbm: 40009,
  tq_garch: 50021,
});

export function deriveSeed(windowId, modelName, pathIdx) {
  const offset = MODEL_OFFSETS[modelName] ?? 90001;
  const h = crypto.createHash('sha256')
    .update(`${BASE_SEED}|${offset}|${windowId}|${pathIdx}`)
    .digest();
  return h.readUInt32LE(0);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeGaussian(rng) {
  let spare = null;
  return function gauss() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    while (u <= 1e-12) u = rng();
    v = rng();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    spare = mag * Math.sin(2.0 * Math.PI * v);
    return mag * Math.cos(2.0 * Math.PI * v);
  };
}

export function quantizePrice(val, tickSize) {
  if (!tickSize || tickSize <= 0) return val;
  const q = Math.round(val / tickSize) * tickSize;
  return Number(q.toFixed(6));
}

export function extractLogRatioTuples(realBars) {
  const tuples = new Array(realBars.length);
  for (let i = 0; i < realBars.length; i += 1) {
    const b = realBars[i];
    const prevC = i === 0 ? b.open : realBars[i - 1].close;
    const o = b.open, h = b.high, l = b.low, c = b.close;
    const hiBody = Math.max(o, c);
    const loBody = Math.min(o, c);
    tuples[i] = {
      gap: i === 0 ? 0.0 : Math.log(o / prevC),
      body: Math.log(c / o),
      upWick: Math.max(0.0, Math.log(h / hiBody)),
      dnWick: Math.max(0.0, Math.log(loBody / l)),
    };
  }
  return tuples;
}

function reconstructFromTuples(realBars, seqTuples) {
  const n = realBars.length;
  const out = new Array(n);
  let prevClose = realBars[0].open;
  for (let i = 0; i < n; i += 1) {
    const t = seqTuples[i];
    const gap = i === 0 ? 0.0 : t.gap;
    const o = prevClose * Math.exp(gap);
    const c = o * Math.exp(t.body);
    const hiBody = Math.max(o, c);
    const loBody = Math.min(o, c);
    const h = hiBody * Math.exp(t.upWick);
    const l = loBody * Math.exp(-t.dnWick);
    out[i] = {
      index: i,
      startTime: realBars[i].startTime,
      endTime: realBars[i].endTime,
      open: o,
      high: Math.max(h, hiBody),
      low: Math.min(l, loBody),
      close: c,
      closed: true,
    };
    prevClose = c;
  }
  return out;
}

export function buildShuffledL1(realBars, rng) {
  const tuples = extractLogRatioTuples(realBars);
  for (let i = tuples.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = tuples[i]; tuples[i] = tuples[j]; tuples[j] = tmp;
  }
  return reconstructFromTuples(realBars, tuples);
}

export function buildCbb(realBars, rng, blockLen = 30) {
  const tuples = extractLogRatioTuples(realBars);
  const n = tuples.length;
  const seq = new Array(n);
  let pos = 0;
  while (pos < n) {
    const start = Math.floor(rng() * n);
    for (let k = 0; k < blockLen && pos < n; k += 1) {
      seq[pos++] = tuples[(start + k) % n];
    }
  }
  return reconstructFromTuples(realBars, seq);
}

export function buildSbb(realBars, rng, meanBlockLen = 30) {
  const tuples = extractLogRatioTuples(realBars);
  const n = tuples.length;
  const pRestart = 1.0 / meanBlockLen;
  const seq = new Array(n);
  let idx = Math.floor(rng() * n);
  for (let pos = 0; pos < n; pos += 1) {
    if (pos > 0) {
      if (rng() < pRestart) {
        idx = Math.floor(rng() * n);
      } else {
        idx = (idx + 1) % n;
      }
    }
    seq[pos] = tuples[idx];
  }
  return reconstructFromTuples(realBars, seq);
}

export function buildGbm(realBars, rng, tickSize = 0, substeps = 60) {
  const n = realBars.length;
  const rets = new Array(n - 1);
  for (let i = 1; i < n; i += 1) {
    rets[i - 1] = Math.log(realBars[i].close / realBars[i - 1].close);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sigma = Math.sqrt(Math.max(variance, 1e-16));
  const dt = 1.0 / substeps;
  const stepDrift = mean * dt;
  const stepVol = sigma * Math.sqrt(dt);
  const gauss = makeGaussian(rng);

  const out = new Array(n);
  let logP = Math.log(realBars[0].open);
  for (let i = 0; i < n; i += 1) {
    const rawO = Math.exp(logP);
    let hi = logP, lo = logP;
    for (let s = 0; s < substeps; s += 1) {
      logP += stepDrift + stepVol * gauss();
      if (logP > hi) hi = logP;
      if (logP < lo) lo = logP;
    }
    const rawC = Math.exp(logP);
    const rawH = Math.exp(hi);
    const rawL = Math.exp(lo);
    let o = tickSize > 0 ? quantizePrice(rawO, tickSize) : rawO;
    let c = tickSize > 0 ? quantizePrice(rawC, tickSize) : rawC;
    let h = tickSize > 0 ? quantizePrice(rawH, tickSize) : rawH;
    let l = tickSize > 0 ? quantizePrice(rawL, tickSize) : rawL;
    if (tickSize > 0) {
      h = Math.max(h, o, c);
      l = Math.min(l, o, c);
    }
    out[i] = {
      index: i,
      startTime: realBars[i].startTime,
      endTime: realBars[i].endTime,
      open: o,
      high: h,
      low: l,
      close: c,
      closed: true,
    };
  }
  return out;
}

export function buildTqGarch(realBars, rng, garchFit, tickSize, substeps = 60, burnIn = 200) {
  const n = realBars.length;
  const mu = garchFit.muLog;
  const omega = garchFit.omega;
  const alpha = garchFit.alpha;
  const beta = garchFit.beta;
  const varUncond = garchFit.varUncond;
  const dt = 1.0 / substeps;
  const stepDrift = mu * dt;
  const gauss = makeGaussian(rng);

  let s2 = varUncond;
  // 200-step burn-in to eliminate initial variance transient
  for (let b = 0; b < burnIn; b += 1) {
    const sigma = Math.sqrt(Math.max(s2, 1e-18));
    const eps = sigma * gauss();
    s2 = omega + alpha * eps * eps + beta * s2;
  }

  const out = new Array(n);
  let logP = Math.log(realBars[0].open);
  for (let i = 0; i < n; i += 1) {
    const barStartLogP = logP;
    const sigma = Math.sqrt(Math.max(s2, 1e-18));
    const stepVol = sigma * Math.sqrt(dt);
    let hi = logP, lo = logP;
    for (let s = 0; s < substeps; s += 1) {
      logP += stepDrift + stepVol * gauss();
      if (logP > hi) hi = logP;
      if (logP < lo) lo = logP;
    }
    const barRet = logP - barStartLogP;
    const eps = barRet - mu;
    s2 = omega + alpha * eps * eps + beta * s2;

    const o = quantizePrice(Math.exp(barStartLogP), tickSize);
    const c = quantizePrice(Math.exp(logP), tickSize);
    let h = quantizePrice(Math.exp(hi), tickSize);
    let l = quantizePrice(Math.exp(lo), tickSize);
    h = Math.max(h, o, c);
    l = Math.min(l, o, c);
    out[i] = {
      index: i,
      startTime: realBars[i].startTime,
      endTime: realBars[i].endTime,
      open: o,
      high: h,
      low: l,
      close: c,
      closed: true,
    };
  }
  return out;
}

export function generateSurrogate(modelName, realBars, windowId, pathIdx, tickSize, garchFit = null) {
  const seed = deriveSeed(windowId, modelName, pathIdx);
  const rng = mulberry32(seed);
  switch (modelName) {
    case 'shuffled_L1': return buildShuffledL1(realBars, rng);
    case 'cbb_L30':     return buildCbb(realBars, rng, 30);
    case 'cbb_L15':     return buildCbb(realBars, rng, 15);
    case 'cbb_L60':     return buildCbb(realBars, rng, 60);
    case 'sbb_L30':     return buildSbb(realBars, rng, 30);
    case 'cont_gbm':    return buildGbm(realBars, rng, 0, 60);
    case 'tq_gbm':      return buildGbm(realBars, rng, tickSize, 60);
    case 'tq_garch':    return buildTqGarch(realBars, rng, garchFit, tickSize, 60, 200);
    default: throw new Error(`Unknown surrogate model: ${modelName}`);
  }
}
