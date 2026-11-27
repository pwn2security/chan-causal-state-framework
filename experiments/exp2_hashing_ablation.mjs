import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createSandboxCore, loadFrozenRuleConfig, R7_INPUTS, OUT_DIR } from './sandbox_core.mjs';

fs.mkdirSync(OUT_DIR, { recursive: true });

function buildWorkload(baseBars, n) {
  const t0 = baseBars[0].startTime;
  return Array.from({ length: n }, (_, index) => {
    const source = baseBars[index % baseBars.length];
    const startTime = t0 + index * 60_000;
    return {
      ...source,
      index,
      startTime,
      endTime: startTime + 59_999,
      sourceStartIndex: index * 60,
      sourceEndIndex: index * 60 + 59,
      closed: true,
    };
  });
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p), hi = Math.ceil(p);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

function digestStructures(structures) {
  return crypto.createHash('sha256').update(JSON.stringify(structures)).digest('hex');
}

function runSingleBenchmark(core, bars, ruleConfig, collectLatencies = true) {
  const parser = new core.CTCoreParser(ruleConfig);
  const latencies = [];
  let peakHeap = process.memoryUsage().heapUsed;
  let peakRss = process.memoryUsage().rss;
  const started = performance.now();
  for (let i = 0; i < bars.length; i += 1) {
    const b0 = performance.now();
    parser.ingestClosedBar(bars[i]);
    const b1 = performance.now();
    if (collectLatencies) latencies.push(b1 - b0);
    if (i % 100 === 0 || i + 1 === bars.length) {
      const mem = process.memoryUsage();
      if (mem.heapUsed > peakHeap) peakHeap = mem.heapUsed;
      if (mem.rss > peakRss) peakRss = mem.rss;
    }
  }
  const totalRuntimeMs = performance.now() - started;
  const structures = parser.getConfirmedStructures();
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    totalRuntimeMs,
    barsPerSecond: bars.length / (totalRuntimeMs / 1000),
    perBarMeanMs: totalRuntimeMs / bars.length,
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    peakHeapBytes: peakHeap,
    peakRssBytes: peakRss,
    counts: {
      K: structures.normalizedK.length,
      F: structures.fractals.length,
      B: structures.strokes.length,
      S: structures.segments.length,
      Z: structures.pivots.length,
    },
    structureSha256: digestStructures(structures),
  };
}

function average(arr, k) {
  return arr.reduce((a, x) => a + x[k], 0) / arr.length;
}

function medianVal(arr, k) {
  const v = arr.map(x => x[k]).sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function fitAlpha(pairs) {
  const xs = pairs.map(([n]) => Math.log(n));
  const ys = pairs.map(([, t]) => Math.log(t));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return Number((num / den).toFixed(3));
}

async function main() {
  const ruleConfig = loadFrozenRuleConfig();
  const baseBars = JSON.parse(
    fs.readFileSync(path.join(R7_INPUTS, 'BTCUSDT-2025-01-02-1s-derived-720.json'), 'utf8')
  ).bars;

  const cores = {
    full_audit: createSandboxCore('full_audit'),
    no_step_hash: createSandboxCore('no_step_hash'),
    audit_hooks_off: createSandboxCore('audit_hooks_off'),
  };

  // 1. Exact bit-for-bit structural equivalence across all 4 July 2026 R4 symbols
  console.log('=== Step 1: Cross-Underlying Structural Equivalence Audit (4 July 2026 720-bar windows) ===');
  const eqFiles = [
    'R4-BTCUSDT-2026-07-FIXED-01.json',
    'R4-ETHUSDT-2026-07-FIXED-01.json',
    'R4-XAUUSDT-2026-07-FIXED-01.json',
    'R4-SPYUSDT-2026-07-FIXED-01.json',
  ];
  const eqAudit = [];
  for (const file of eqFiles) {
    const bars = JSON.parse(fs.readFileSync(path.join(R7_INPUTS, file), 'utf8')).bars.map(b => ({ ...b, closed: true }));
    const rFull = runSingleBenchmark(cores.full_audit, bars, ruleConfig, false);
    const rNoHash = runSingleBenchmark(cores.no_step_hash, bars, ruleConfig, false);
    const rOff = runSingleBenchmark(cores.audit_hooks_off, bars, ruleConfig, false);
    if (rFull.structureSha256 !== rNoHash.structureSha256 || rFull.structureSha256 !== rOff.structureSha256) {
      throw new Error(`EQUIVALENCE_FAILURE:${file}`);
    }
    eqAudit.push({
      windowId: file.replace('.json', ''),
      rows: bars.length,
      counts: rFull.counts,
      fullAuditMs: Number(rFull.totalRuntimeMs.toFixed(2)),
      noStepHashMs: Number(rNoHash.totalRuntimeMs.toFixed(2)),
      auditHooksOffMs: Number(rOff.totalRuntimeMs.toFixed(2)),
      speedupNoStepHash: Number((rFull.totalRuntimeMs / rNoHash.totalRuntimeMs).toFixed(2)),
      speedupAuditHooksOff: Number((rFull.totalRuntimeMs / rOff.totalRuntimeMs).toFixed(2)),
      exactStructureMatch: true,
      structureSha256: rFull.structureSha256,
    });
    console.log(`  ${file.replace('.json', '')}: full=${(rFull.totalRuntimeMs/1000).toFixed(2)}s | noHash=${(rNoHash.totalRuntimeMs/1000).toFixed(2)}s (${(rFull.totalRuntimeMs/rNoHash.totalRuntimeMs).toFixed(2)}x) | hooksOff=${(rOff.totalRuntimeMs/1000).toFixed(2)}s (${(rFull.totalRuntimeMs/rOff.totalRuntimeMs).toFixed(1)}x) | EXACT MATCH`);
  }

  // 2. Scaling Ablation Grid matching E5-X exact repeated 720-bar workload
  // For full_audit at N=1000 and 2000 we run 1 timed verification run (matching frozen E5-X: 170.3s, 424.5s)
  // while no_step_hash and audit_hooks_off get full multi-run timing up to N=5000!
  console.log('\n=== Step 2: Controlled 3-Tier Scaling Ablation (N=120..5000) ===');
  const grid = [
    { n: 120,  modes: { full_audit: 3, no_step_hash: 3, audit_hooks_off: 5 } },
    { n: 500,  modes: { full_audit: 2, no_step_hash: 3, audit_hooks_off: 5 } },
    { n: 1000, modes: { full_audit: 1, no_step_hash: 2, audit_hooks_off: 3 } },
    { n: 2000, modes: {                no_step_hash: 1, audit_hooks_off: 2 } },
    { n: 5000, modes: {                                 audit_hooks_off: 2 } },
  ];

  const scalingResults = [];
  for (const item of grid) {
    const bars = buildWorkload(baseBars, item.n);
    const point = { bars: item.n, modes: {} };
    for (const [mode, runs] of Object.entries(item.modes)) {
      const doWarmup = (item.n <= 500) || (mode === 'audit_hooks_off' && item.n <= 1000);
      const warmHash = doWarmup ? runSingleBenchmark(cores[mode], bars, ruleConfig, false).structureSha256 : null;
      const measured = [];
      for (let r = 0; r < runs; r += 1) {
        measured.push(runSingleBenchmark(cores[mode], bars, ruleConfig, true));
      }
      const hashes = new Set(measured.map(x => x.structureSha256));
      if (warmHash) hashes.add(warmHash);
      if (hashes.size !== 1) throw new Error(`NON_DETERMINISTIC:${mode}:N=${item.n}`);
      point.modes[mode] = {
        measuredRuns: runs,
        meanTotalRuntimeMs: Number(average(measured, 'totalRuntimeMs').toFixed(3)),
        meanTotalRuntimeSec: Number((average(measured, 'totalRuntimeMs') / 1000).toFixed(3)),
        meanBarsPerSecond: Number(average(measured, 'barsPerSecond').toFixed(3)),
        meanPerBarMs: Number(average(measured, 'perBarMeanMs').toFixed(6)),
        p50Ms: Number(medianVal(measured, 'p50Ms').toFixed(6)),
        p95Ms: Number(medianVal(measured, 'p95Ms').toFixed(6)),
        p99Ms: Number(medianVal(measured, 'p99Ms').toFixed(6)),
        maxPeakHeapBytes: Math.max(...measured.map(x => x.peakHeapBytes)),
        maxPeakRssBytes: Math.max(...measured.map(x => x.peakRssBytes)),
        counts: measured[0].counts,
        structureSha256: measured[0].structureSha256,
      };
    }
    const modeHashes = new Set(Object.values(point.modes).map(m => m.structureSha256));
    point.allExecutedModesExactMatch = modeHashes.size === 1;
    if (!point.allExecutedModesExactMatch) throw new Error(`CROSS_MODE_MISMATCH:N=${item.n}`);
    scalingResults.push(point);
    const fmt = (m) => point.modes[m] ? `${point.modes[m].meanTotalRuntimeSec.toFixed(3)}s` : '---';
    console.log(`  N=${String(item.n).padStart(5)}: full=${fmt('full_audit').padStart(8)} | no_step_hash=${fmt('no_step_hash').padStart(8)} | audit_hooks_off=${fmt('audit_hooks_off').padStart(8)} | EXACT=${point.allExecutedModesExactMatch}`);
  }

  // Empirical scaling exponents (using frozen E5-X full_audit [0.662, 18.314, 170.349, 424.475] alongside our ablation!)
  const frozenE5X = [[120, 662], [500, 18314], [1000, 170349], [2000, 424475]];
  const noHashPairs = scalingResults.filter(p => p.modes.no_step_hash).map(p => [p.bars, p.modes.no_step_hash.meanTotalRuntimeMs]);
  const offPairs = scalingResults.filter(p => p.modes.audit_hooks_off).map(p => [p.bars, p.modes.audit_hooks_off.meanTotalRuntimeMs]);

  const exponents = {
    frozen_full_audit_120_2000: fitAlpha(frozenE5X),
    no_step_hash_120_2000: fitAlpha(noHashPairs),
    audit_hooks_off_120_5000: fitAlpha(offPairs),
    audit_hooks_off_500_5000: fitAlpha(offPairs.filter(([n]) => n >= 500)),
  };
  console.log('\nEmpirical log-log scaling exponents (T ~ N^alpha):', exponents);

  const out = {
    schemaVersion: 'PhysicaA-Exp2-AuditOverheadAblation-v1.1',
    generatedAtUtc: new Date().toISOString(),
    nodeVersion: process.version,
    parserVersion: 'CT-Core-Parser-R1.0.4',
    frozenBaselineUntouched: true,
    frozenE5XReferenceSec: { 120: 0.662, 500: 18.314, 1000: 170.349, 2000: 424.475, 5000: null, 10000: null },
    equivalenceAudit: eqAudit,
    scalingGrid: scalingResults,
    empiricalScalingExponents: exponents,
  };
  const outPath = path.join(OUT_DIR, 'exp2_hashing_ablation.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\nSaved: ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
