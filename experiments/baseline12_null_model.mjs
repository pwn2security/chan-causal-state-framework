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

function buildShuffledReturnSurrogate(realBars, rng) {
  const tuples = [];
  for (let i = 0; i < realBars.length; i += 1) {
    const b = realBars[i];
    const prevC = i === 0 ? b.open : realBars[i - 1].close;
    const o = b.open, h = b.high, l = b.low, c = b.close;
    const hiBody = Math.max(o, c);
    const loBody = Math.min(o, c);
    tuples.push({
      gap: Math.log(o / prevC),
      body: Math.log(c / o),
      upWick: Math.max(0, Math.log(h / hiBody)),
      dnWick: Math.max(0, Math.log(loBody / l)),
    });
  }
  for (let i = tuples.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = tuples[i]; tuples[i] = tuples[j]; tuples[j] = tmp;
  }
  const out = [];
  let prevClose = realBars[0].open;
  for (let i = 0; i < realBars.length; i += 1) {
    const t = tuples[i];
    const o = prevClose * Math.exp(t.gap);
    const c = o * Math.exp(t.body);
    const hiBody = Math.max(o, c);
    const loBody = Math.min(o, c);
    out.push({
      index: i,
      startTime: realBars[i].startTime,
      endTime: realBars[i].endTime,
      open: o,
      high: hiBody * Math.exp(t.upWick),
      low: loBody * Math.exp(-t.dnWick),
      close: c,
      closed: true,
    });
    prevClose = c;
  }
  return out;
}

function buildGbmSurrogate(realBars, rng, substeps = 60) {
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
    const o = Math.exp(logP);
    let hi = logP, lo = logP;
    for (let s = 0; s < substeps; s += 1) {
      logP += stepDrift + stepVol * gauss();
      if (logP > hi) hi = logP;
      if (logP < lo) lo = logP;
    }
    out.push({
      index: i,
      startTime: realBars[i].startTime,
      endTime: realBars[i].endTime,
      open: o,
      high: Math.exp(hi),
      low: Math.exp(lo),
      close: Math.exp(logP),
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
  const fLags = lagsMin(st.fractals);
  const bLags = lagsMin(st.strokes);
  const sLags = lagsMin(st.segments);
  const zLags = lagsMin(st.pivots);
  return {
    N, K, F, B, S, Z,
    K_over_N: K / N,
    F_over_K: K > 0 ? F / K : null,
    B_over_K: K > 0 ? B / K : null,
    B_over_F: F > 0 ? B / F : null,
    S_over_B: B > 0 ? S / B : null,
    median_lag_F: median(fLags),
    median_lag_B: median(bLags),
    median_lag_S: median(sLags),
    median_lag_Z: median(zLags),
    mean_lag_B: bLags.length ? bLags.reduce((a, b) => a + b, 0) / bLags.length : null,
    mean_lag_S: sLags.length ? sLags.reduce((a, b) => a + b, 0) / sLags.length : null,
  };
}

if (!isMainThread) {
  // Worker executes one window (1 real + M shuffled + M GBM) deterministically from its own seed
  const { file, windowIndex, M, baseSeed } = workerData;
  const ruleConfig = loadFrozenRuleConfig();
  const coreFast = createSandboxCore('audit_hooks_off');
  const windowId = file.replace('.json', '');
  const symbol = windowId.split('-')[1];
  const realBars = JSON.parse(fs.readFileSync(path.join(R7_INPUTS, file), 'utf8')).bars.map(b => ({ ...b, closed: true }));

  const rng = mulberry32(baseSeed + windowIndex * 10007);
  const rows = [];
  const spotChecks = [];

  const realMetrics = evaluateBars(coreFast, ruleConfig, realBars);
  rows.push({ windowId, symbol, model: 'REAL', pathIndex: 0, ...realMetrics });

  // Spot-check path 0 against full_audit on first 4 windows (one per symbol) for bit-exact verification
  const doFullSpotCheck = windowIndex < 4;
  const coreFull = doFullSpotCheck ? createSandboxCore('full_audit') : null;
  if (doFullSpotCheck) {
    const rFull = evaluateBars(coreFull, ruleConfig, realBars);
    if (JSON.stringify(rFull) !== JSON.stringify(realMetrics)) {
      throw new Error(`REAL_SPOT_CHECK_MISMATCH:${windowId}`);
    }
    spotChecks.push({ windowId, model: 'REAL', pathIndex: 0, exactMatchWithFullAudit: true });
  }

  for (let m = 0; m < M; m += 1) {
    const sur = buildShuffledReturnSurrogate(realBars, rng);
    const met = evaluateBars(coreFast, ruleConfig, sur);
    if (doFullSpotCheck && m === 0) {
      const metFull = evaluateBars(coreFull, ruleConfig, sur);
      if (JSON.stringify(met) !== JSON.stringify(metFull)) {
        throw new Error(`NULL1_SPOT_CHECK_MISMATCH:${windowId}`);
      }
      spotChecks.push({ windowId, model: 'NULL_SHUFFLED', pathIndex: 0, exactMatchWithFullAudit: true });
    }
    rows.push({ windowId, symbol, model: 'NULL_SHUFFLED', pathIndex: m, ...met });
  }

  for (let m = 0; m < M; m += 1) {
    const sur = buildGbmSurrogate(realBars, rng, 60);
    const met = evaluateBars(coreFast, ruleConfig, sur);
    if (doFullSpotCheck && m === 0) {
      const metFull = evaluateBars(coreFull, ruleConfig, sur);
      if (JSON.stringify(met) !== JSON.stringify(metFull)) {
        throw new Error(`NULL2_SPOT_CHECK_MISMATCH:${windowId}`);
      }
      spotChecks.push({ windowId, model: 'NULL_GBM', pathIndex: 0, exactMatchWithFullAudit: true });
    }
    rows.push({ windowId, symbol, model: 'NULL_GBM', pathIndex: m, ...met });
  }

  parentPort.postMessage({ windowIndex, windowId, rows, spotChecks, realMetrics });
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const M = 50; // 50 Monte Carlo surrogates per window x 12 windows x 2 null models = 1,200 paths
  const SEED = 20261127;
  const r4Files = fs.readdirSync(R7_INPUTS).filter(f => f.startsWith('R4-') && f.endsWith('.json')).sort();
  if (r4Files.length !== 12) throw new Error(`Expected 12 R4 windows, got ${r4Files.length}`);

  const maxWorkers = Math.min(8, Math.max(2, os.cpus().length - 2));
  const selfFile = fileURLToPath(import.meta.url);
  const tStart = Date.now();
  console.log(`Launching Exp 1 Null-Model Benchmark: 12 windows x ${M} paths x 2 nulls = ${12 * M * 2} trajectories across ${maxWorkers} worker threads...`);

  const resultsByWindow = new Array(r4Files.length);
  let nextIdx = 0;
  let completed = 0;

  await new Promise((resolve, reject) => {
    function spawnNext() {
      if (nextIdx >= r4Files.length) return;
      const wi = nextIdx++;
      const worker = new Worker(selfFile, {
        workerData: { file: r4Files[wi], windowIndex: wi, M, baseSeed: SEED },
      });
      worker.on('message', (msg) => {
        resultsByWindow[msg.windowIndex] = msg;
        completed += 1;
        const rm = msg.realMetrics;
        console.log(`  [${completed}/12] ${msg.windowId} done (${((Date.now() - tStart) / 1000).toFixed(1)}s) | REAL: K=${rm.K}, F/K=${(rm.F_over_K*100).toFixed(2)}%, B/K=${(rm.B_over_K*100).toFixed(2)}%, S=${rm.S}, Z=${rm.Z}`);
        if (completed === r4Files.length) resolve();
        else spawnNext();
      });
      worker.on('error', reject);
    }
    for (let k = 0; k < Math.min(maxWorkers, r4Files.length); k += 1) spawnNext();
  });

  const records = resultsByWindow.flatMap(r => r.rows);
  const spotChecks = resultsByWindow.flatMap(r => r.spotChecks);
  const outPath = path.join(OUT_DIR, 'baseline12_null_model_raw.json');
  fs.writeFileSync(outPath, JSON.stringify({
    schemaVersion: 'PhysicaA-Exp1-NullModel-v1.1',
    generatedAtUtc: new Date().toISOString(),
    seed: SEED,
    surrogatesPerWindowPerModel: M,
    windowCount: r4Files.length,
    totalNullPaths: r4Files.length * M * 2,
    spotChecksAgainstFullAudit: spotChecks,
    records,
  }, null, 2) + '\n', 'utf8');
  console.log(`\nSaved raw null-model records: ${outPath} (total elapsed ${((Date.now() - tStart) / 1000).toFixed(1)}s)`);
}
