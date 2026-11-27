import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createSandboxCore, loadFrozenRuleConfig, R7_INPUTS, OUT_DIR } from './sandbox_core.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGaussian(rng) {
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

function inferTickSize(bars) {
  const prices = [];
  for (const b of bars) {
    prices.push(b.open, b.high, b.low, b.close);
  }
  const uniq = [...new Set(prices)].sort((a, b) => a - b);
  let minDiff = Infinity;
  for (let i = 1; i < uniq.length; i += 1) {
    const d = +(uniq[i] - uniq[i - 1]).toFixed(10);
    if (d > 1e-9 && d < minDiff) minDiff = d;
  }
  return minDiff;
}

function measureBarMicrostructure(bars) {
  const N = bars.length;
  let zeroRange = 0;
  let equalHighAdj = 0;
  let equalLowAdj = 0;
  let equalEitherBoundAdj = 0;
  let rawInclusionAny = 0;
  let rawInclusionWithEq = 0;
  let rawInclusionStrict = 0;
  for (let i = 0; i < N; i += 1) {
    const b = bars[i];
    if (b.high === b.low) zeroRange += 1;
    if (i > 0) {
      const p = bars[i - 1];
      const eqH = b.high === p.high;
      const eqL = b.low === p.low;
      if (eqH) equalHighAdj += 1;
      if (eqL) equalLowAdj += 1;
      if (eqH || eqL) equalEitherBoundAdj += 1;
      const inc = (b.high <= p.high && b.low >= p.low) || (p.high <= b.high && p.low >= b.low);
      if (inc) {
        rawInclusionAny += 1;
        if (eqH || eqL) rawInclusionWithEq += 1;
        else rawInclusionStrict += 1;
      }
    }
  }
  const pairs = Math.max(1, N - 1);
  return {
    N,
    zeroRangeCount: zeroRange,
    zeroRangePct: +(zeroRange / N * 100).toFixed(4),
    equalHighAdjPct: +(equalHighAdj / pairs * 100).toFixed(4),
    equalLowAdjPct: +(equalLowAdj / pairs * 100).toFixed(4),
    equalEitherBoundAdjPct: +(equalEitherBoundAdj / pairs * 100).toFixed(4),
    rawInclusionAnyPct: +(rawInclusionAny / pairs * 100).toFixed(4),
    rawInclusionWithEqPct: +(rawInclusionWithEq / pairs * 100).toFixed(4),
    rawInclusionStrictPct: +(rawInclusionStrict / pairs * 100).toFixed(4),
  };
}

function quantizePrice(val, tick) {
  return +(Math.round(val / tick) * tick).toFixed(8);
}

function buildTickQuantizedGbmSurrogate(realBars, rng, tick, substeps = 60) {
  const rets = [];
  for (let i = 1; i < realBars.length; i += 1) {
    rets.push(Math.log(realBars[i].close / realBars[i - 1].close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sigma = Math.sqrt(Math.max(variance, 1e-16));
  const dt = 1.0 / substeps;
  const stepDrift = mean * dt;
  const stepVol = sigma * Math.sqrt(dt);
  const gauss = makeGaussian(rng);

  const out = [];
  let logP = Math.log(realBars[0].open);
  for (let i = 0; i < realBars.length; i += 1) {
    const oRaw = Math.exp(logP);
    let hi = logP, lo = logP;
    for (let s = 0; s < substeps; s += 1) {
      logP += stepDrift + stepVol * gauss();
      if (logP > hi) hi = logP;
      if (logP < lo) lo = logP;
    }
    const o = quantizePrice(oRaw, tick);
    const c = quantizePrice(Math.exp(logP), tick);
    const h = Math.max(o, c, quantizePrice(Math.exp(hi), tick));
    const l = Math.min(o, c, quantizePrice(Math.exp(lo), tick));
    out.push({
      index: i,
      startTime: realBars[i].startTime,
      endTime: realBars[i].endTime,
      open: o,
      high: h,
      low: l,
      close: c,
      closed: true,
    });
  }
  return out;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function evaluateBars(core, ruleConfig, bars) {
  const parser = new core.CTCoreParser(ruleConfig);
  for (const b of bars) parser.ingestClosedBar(b);
  const st = parser.getConfirmedStructures();
  const N = bars.length;
  const K = st.normalizedK.length;
  const F = st.fractals.length;
  const B = st.strokes.length;
  const S = st.segments.length;
  const Z = st.pivots.length;
  const lagsMin = list => list
    .filter(x => Number.isFinite(x.confirmRawBarIndex) && Number.isFinite(x.eventRawBarIndex))
    .map(x => x.confirmRawBarIndex - x.eventRawBarIndex);
  const bLags = lagsMin(st.strokes);
  const sLags = lagsMin(st.segments);
  return {
    N, K, F, B, S, Z,
    K_over_N: K / N,
    F_over_K: K > 0 ? F / K : null,
    B_over_K: K > 0 ? B / K : null,
    B_over_F: F > 0 ? B / F : null,
    median_lag_S: median(sLags),
    mean_lag_B: bLags.length ? bLags.reduce((a, b) => a + b, 0) / bLags.length : null,
    ...measureBarMicrostructure(bars),
  };
}

if (!isMainThread) {
  const { file, windowIndex, M, baseSeed } = workerData;
  const ruleConfig = loadFrozenRuleConfig();
  const coreFast = createSandboxCore('audit_hooks_off');
  const windowId = file.replace('.json', '');
  const parts = windowId.split('-');
  const symbol = parts[1];
  const month = `${parts[2]}-${parts[3]}`;
  const realBars = JSON.parse(fs.readFileSync(path.join(R7_INPUTS, file), 'utf8')).bars.map(b => ({ ...b, closed: true }));
  const tick = inferTickSize(realBars);

  const realMetrics = evaluateBars(coreFast, ruleConfig, realBars);
  // Use fresh deterministic seed derived from baseSeed + 99991 so independent of continuous GBM stream
  const rng = mulberry32(baseSeed + 99991 + windowIndex * 10007);
  const tqRows = [];
  for (let m = 0; m < M; m += 1) {
    const sur = buildTickQuantizedGbmSurrogate(realBars, rng, tick, 60);
    const met = evaluateBars(coreFast, ruleConfig, sur);
    tqRows.push({ windowId, symbol, month, tick, model: 'NULL_GBM_TICK_QUANTIZED', pathIndex: m, ...met });
  }
  parentPort.postMessage({
    windowIndex,
    windowId,
    symbol,
    month,
    tick,
    realRow: { windowId, symbol, month, tick, model: 'REAL', pathIndex: 0, ...realMetrics },
    tqRows,
  });
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const M = 50;
  const SEED = 20261127;
  const r4Files = fs.readdirSync(R7_INPUTS).filter(f => f.startsWith('R4-') && f.endsWith('.json')).sort();
  const maxWorkers = Math.min(8, Math.max(2, os.cpus().length - 2));
  const selfFile = fileURLToPath(import.meta.url);
  const t0 = Date.now();
  console.log(`Running Exp 1 v22 Discretization & Tick-Quantized GBM across 12 R4 windows x ${M} paths...`);

  const outByIdx = new Array(r4Files.length);
  let nextIdx = 0;
  let done = 0;
  await new Promise((resolve, reject) => {
    function spawnNext() {
      if (nextIdx >= r4Files.length) return;
      const wi = nextIdx++;
      const w = new Worker(selfFile, { workerData: { file: r4Files[wi], windowIndex: wi, M, baseSeed: SEED } });
      w.on('message', (msg) => {
        outByIdx[msg.windowIndex] = msg;
        done += 1;
        const avgKN = msg.tqRows.reduce((s, r) => s + r.K_over_N, 0) / msg.tqRows.length * 100;
        const avgZero = msg.tqRows.reduce((s, r) => s + r.zeroRangePct, 0) / msg.tqRows.length;
        console.log(`  [${done}/12] ${msg.windowId} (tick=${msg.tick}) | REAL: zero=${msg.realRow.zeroRangePct.toFixed(2)}%, eqBound=${msg.realRow.equalEitherBoundAdjPct.toFixed(2)}%, K/N=${(msg.realRow.K_over_N*100).toFixed(2)}% | TQ-GBM: zero=${avgZero.toFixed(2)}%, K/N=${avgKN.toFixed(2)}%`);
        if (done === r4Files.length) resolve();
        else spawnNext();
      });
      w.on('error', reject);
    }
    for (let k = 0; k < Math.min(maxWorkers, r4Files.length); k += 1) spawnNext();
  });

  const payload = {
    schemaVersion: 'PhysicaA-Exp1-Discretization-v1.0',
    generatedAtUtc: new Date().toISOString(),
    seed: SEED + 99991,
    surrogatesPerWindow: M,
    realRecords: outByIdx.map(x => x.realRow),
    tickQuantizedGbmRecords: outByIdx.flatMap(x => x.tqRows),
  };
  const outPath = path.join(OUT_DIR, 'exp1_v22_discretization.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`\nSaved ${outPath} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
