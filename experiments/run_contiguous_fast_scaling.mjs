import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createFastSandboxCore, loadFrozenRuleConfig } from './incremental_tail_sandbox.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = process.env.CT_DATA_ROOT || path.join(REPO_ROOT, 'local_data', 'extended_validation');
const OUT_DIR = process.env.CT_RESULTS_DIR || path.join(REPO_ROOT, 'results');
fs.mkdirSync(OUT_DIR, { recursive: true });
const WIN_PATH = process.env.CT_SCALING_WINDOW || path.join(DATA_ROOT, 'windows', 'scaling_contiguous', 'R8-SCALING-BTCUSDT-2026-07-01-10000-1M.json');
const OUT_CSV = path.join(OUT_DIR, 'table_contiguous_scaling_memoized_tail.csv');

const win = JSON.parse(fs.readFileSync(WIN_PATH, 'utf8'));
const allBars = win.bars;
const ruleConfig = loadFrozenRuleConfig();

function runFast(bars) {
  const core = createFastSandboxCore();
  const parser = new core.CTCoreParser(ruleConfig);
  const stepMs = new Float64Array(bars.length);
  const t0 = performance.now();
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const s0 = performance.now();
    parser.ingestClosedBar({
      index: i,
      startTime: b.startTime,
      endTime: b.endTime,
      open: b.open, high: b.high, low: b.low, close: b.close,
      closed: true,
    });
    stepMs[i] = performance.now() - s0;
  }
  const elapsedSec = (performance.now() - t0) / 1000;
  const s = parser.getConfirmedStructures();
  return {
    elapsedSec,
    stepMs: Array.from(stepMs),
    counts: {
      K: s.normalizedK.length,
      F: s.fractals.length,
      B: s.strokes.length,
      S: s.segments.length,
      Z: s.pivots.length,
    },
  };
}

// Warm-up on 120 bars
runFast(allBars.slice(0, 120));

const Ns = [120, 500, 1000, 2000, 2880, 5000, 10000];
const rows = ['N,elapsedSec,meanMs,p50Ms,p95Ms,p99Ms,tail250P99Ms,K_over_N,B_over_K,S,Z'];
for (const N of Ns) {
  const res = runFast(allBars.slice(0, N));
  const sorted = [...res.stepMs].sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))];
  const tail = [...res.stepMs.slice(Math.max(0, N - 250))].sort((a, b) => a - b);
  const meanMs = res.stepMs.reduce((a, b) => a + b, 0) / N;
  const { K, B, S, Z } = res.counts;
  const line = `${N},${res.elapsedSec.toFixed(6)},${meanMs.toFixed(6)},${q(sorted, 0.5).toFixed(6)},${q(sorted, 0.95).toFixed(6)},${q(sorted, 0.99).toFixed(6)},${q(tail, 0.99).toFixed(6)},${(K/N*100).toFixed(3)},${(B/K*100).toFixed(3)},${S},${Z}`;
  console.log(line);
  rows.push(line);
}
fs.writeFileSync(OUT_CSV, rows.join('\n') + '\n', 'utf8');
console.log('Saved:', OUT_CSV);

