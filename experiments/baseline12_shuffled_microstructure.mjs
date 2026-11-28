/**
 * Exp 1 v24 Shuffled-Return Microstructure Diagnostic (Table S12.1(a)):
 * Reproduces exact zero-range flat-bar share (Zero%: H_t == L_t) and adjacent
 * equal-bound share (EqB%: H_t == H_{t-1} || L_t == L_{t-1}) across the 600
 * shuffled-return OHLC surrogates (12 fixed windows x 50 paths, seed 20261127)
 * using the identical mulberry32 PRNG and log-ratio shuffle as baseline12_null_model.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { R7_INPUTS, OUT_DIR } from './sandbox_core.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildShuffledReturnSurrogate(realBars, rng) {
  const tuples = [];
  for (let i = 0; i < realBars.length; i += 1) {
    const b = realBars[i];
    const prevC = i === 0 ? b.open : realBars[i - 1].close;
    const o = b.open;
    const h = b.high;
    const l = b.low;
    const c = b.close;
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
    const tmp = tuples[i];
    tuples[i] = tuples[j];
    tuples[j] = tmp;
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
      high: hiBody * Math.exp(t.upWick),
      low: loBody * Math.exp(-t.dnWick),
    });
    prevClose = c;
  }
  return out;
}

function measureMicrostructure(bars) {
  let zeroRange = 0;
  let eqBound = 0;
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].high === bars[i].low) zeroRange += 1;
    if (i > 0 && (bars[i].high === bars[i - 1].high || bars[i].low === bars[i - 1].low)) {
      eqBound += 1;
    }
  }
  return {
    zeroRangePct: (zeroRange / bars.length) * 100,
    eqBoundPct: (eqBound / (bars.length - 1)) * 100,
  };
}

const M = 50;
const BASE_SEED = 20261127;
const r4Files = fs.readdirSync(R7_INPUTS).filter(f => f.startsWith('R4-') && f.endsWith('.json')).sort();
if (r4Files.length !== 12) {
  throw new Error(`Expected 12 R4 windows in ${R7_INPUTS}, got ${r4Files.length}`);
}

const bySymbol = new Map();
for (let wi = 0; wi < r4Files.length; wi += 1) {
  const file = r4Files[wi];
  const symbol = file.split('-')[1];
  const realBars = JSON.parse(fs.readFileSync(path.join(R7_INPUTS, file), 'utf8')).bars;
  const rng = mulberry32(BASE_SEED + wi * 10007);
  if (!bySymbol.has(symbol)) bySymbol.set(symbol, { zero: [], eqb: [] });
  const bucket = bySymbol.get(symbol);
  for (let m = 0; m < M; m += 1) {
    const sur = buildShuffledReturnSurrogate(realBars, rng);
    const stats = measureMicrostructure(sur);
    bucket.zero.push(stats.zeroRangePct);
    bucket.eqb.push(stats.eqBoundPct);
  }
}

const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const summary = {};
for (const sym of [...bySymbol.keys()].sort()) {
  const b = bySymbol.get(sym);
  summary[sym] = {
    nPaths: b.zero.length,
    shufZeroRangePct: Number(mean(b.zero).toFixed(2)),
    shufEqBoundPct: Number(mean(b.eqb).toFixed(2)),
  };
  console.log(`${sym.padEnd(8)} (n=${b.zero.length}): Zero% = ${summary[sym].shufZeroRangePct.toFixed(2)}% | EqB% = ${summary[sym].shufEqBoundPct.toFixed(2)}%`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, 'baseline12_shuffled_microstructure.json');
fs.writeFileSync(outPath, JSON.stringify({
  schemaVersion: 'PhysicaA-Exp1-ShuffledMicrostructure-v1.0',
  seed: BASE_SEED,
  pathsPerWindow: M,
  bySymbol: summary,
}, null, 2) + '\n', 'utf8');
console.log(`Saved ${outPath}`);
