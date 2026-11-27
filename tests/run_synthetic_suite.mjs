/**
 * Self-contained offline verification suite for CT-Core-Parser-R1.0.4 (Snapshot v5).
 * Requires zero external market data; validates:
 *   1. Deterministic multi-layer cascade (K -> F -> B -> S -> Z) on synthetic OHLC streams
 *   2. Online prefix consistency (CR = 1.0 across all cuts)
 *   3. Append-only historical publication non-revision (HRR = 0.0 across adversarial future suffixes)
 *   4. Future-only checkpoint restart continuity (RCR = 1.0 without pre-checkpoint history replay)
 *   5. Microscopic Stroke-separation rule sensitivity (minimumStrokeSeparation: 2 vs 4)
 *   6. Bit-for-bit structural equivalence when non-semantic audit hooks are disabled
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CORE_SCRIPTS = Object.freeze([
  'src/models.js', 'src/market-core.js', 'src/ct-v5/model.js', 'src/ct-v5/rule-config.js',
  'src/ct-v5/state-hash.js', 'src/ct-v5/snapshot.js', 'src/ct-v5/normalized-k.js',
  'src/ct-v5/fractal.js', 'src/ct-v5/stroke.js', 'src/ct-v5/segment-rule-contract.js',
  'src/ct-v5/segment-feature-sequence.js', 'src/ct-v5/segment-feature-standardizer.js',
  'src/ct-v5/segment-feature-fractal.js', 'src/ct-v5/segment-feature-direction.js',
  'src/ct-v5/segment-feature-inclusion-r1.js', 'src/ct-v5/segment-case1.js',
  'src/ct-v5/segment-case2.js', 'src/ct-v5/segment-endpoint-proposal.js',
  'src/ct-v5/segment-endpoint-replacement.js', 'src/ct-v5/segment-sequential-handoff.js',
  'src/ct-v5/segment.js', 'src/ct-v5/segment-guarded-runner.js',
  'src/ct-v5/segment-sequential-verify.js', 'src/ct-v5/pivot.js',
  'src/ct-v5/ct-parser-pipeline.js', 'src/ct-v5/core-parser-api.js',
]);

function loadCore(mode = 'full_audit') {
  const ctx = vm.createContext({ window: {}, console, performance });
  for (const rel of CORE_SCRIPTS) {
    let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (mode === 'audit_hooks_off' && rel === 'src/ct-v5/model.js') {
      src = src
        .replace('function clonePlain(value) {', 'function clonePlain(value) { return value;')
        .replace('function deepFreeze(value) {', 'function deepFreeze(value) { return value;')
        .replace('function estimateActiveMemorySize(value) {', 'function estimateActiveMemorySize(value) { return 0;');
    }
    if (mode === 'audit_hooks_off' && rel === 'src/ct-v5/state-hash.js') {
      src = src.replace(
        'function attachStateHash(state, options = {}) {',
        'function attachStateHash(state, options = {}) { return { ...state, stateHash: null };'
      );
    }
    vm.runInContext(src, ctx, { filename: rel });
  }
  const core = ctx.window.MarketCore;
  assert.equal(core.CT_CORE_PARSER_VERSION, 'CT-Core-Parser-R1.0.4');
  return core;
}

function loadRuleConfig(overrides = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/ct-core-parser-r1.0.3.json'), 'utf8')).frozenRuleConfig;
  return { ...base, ...overrides };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic synthetic multiscale OHLC generator (oscillating regimes + noise to trigger K, F, B, S, Z)
function generateSyntheticStream(length = 260, seed = 20261127, regimeBias = 0.0) {
  const rng = mulberry32(seed);
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const bars = [];
  let price = 1000.0;
  for (let i = 0; i < length; i += 1) {
    const wave = 18.0 * Math.sin(i / 14.0) + 6.0 * Math.sin(i / 2.7);
    const shock = (rng() - 0.5) * 4.5 + regimeBias;
    const open = price;
    const close = Math.max(100.0, 1000.0 + wave + shock + (i * regimeBias * 0.15));
    const wickUp = Math.abs((rng() - 0.15) * 3.2);
    const wickDn = Math.abs((rng() - 0.15) * 3.2);
    const high = Math.max(open, close) + wickUp;
    const low = Math.max(50.0, Math.min(open, close) - wickDn);
    bars.push({
      index: i,
      startTime: t0 + i * 60_000,
      endTime: t0 + i * 60_000 + 59_999,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      closed: true,
    });
    price = close;
  }
  return bars;
}

function runSuite() {
  const core = loadCore('full_audit');
  const coreFast = loadCore('audit_hooks_off');
  const cfg = loadRuleConfig();
  const bars = generateSyntheticStream(240, 20261127);

  // Test 1: Deterministic cascade + structural-time ordering
  const p1 = new core.CTCoreParser(cfg);
  const p2 = new core.CTCoreParser(cfg);
  for (const b of bars) { p1.ingestClosedBar(b); p2.ingestClosedBar(b); }
  const s1 = p1.getConfirmedStructures();
  const s2 = p2.getConfirmedStructures();
  assert.equal(JSON.stringify(s1), JSON.stringify(s2), 'Determinism violated');
  assert.ok(s1.normalizedK.length > 0 && s1.fractals.length > 0 && s1.strokes.length > 0, 'Lower layers empty');
  assert.ok(s1.segments.length >= 3 && s1.pivots.length >= 1, `Expected S>=3, Z>=1; got S=${s1.segments.length}, Z=${s1.pivots.length}`);
  for (const layer of ['normalizedK', 'fractals', 'strokes', 'segments', 'pivots']) {
    for (const rec of s1[layer]) {
      assert.ok(rec.confirmTime >= rec.eventTime, `Causal clock inversion in ${layer}`);
    }
  }
  console.log(`[PASS] 1. Deterministic multiscale cascade & causal clock order (K=${s1.normalizedK.length}, F=${s1.fractals.length}, B=${s1.strokes.length}, S=${s1.segments.length}, Z=${s1.pivots.length})`);

  // Test 2: Online prefix consistency (CR = 1.0 across cuts)
  const cuts = [10, 35, 75, 120, 180, 240];
  const online = new core.CTCoreParser(cfg);
  const onlineAt = new Map();
  bars.forEach((b, idx) => {
    online.ingestClosedBar(b);
    if (cuts.includes(idx + 1)) onlineAt.set(idx + 1, online.getCurrentState());
  });
  for (const c of cuts) {
    const fresh = new core.CTCoreParser(cfg);
    fresh.ingestClosedBars(bars.slice(0, c));
    const cmp = core.compareCoreParserSemantics(onlineAt.get(c), fresh.getCurrentState());
    assert.equal(cmp.equal, true, `Prefix mismatch at cut ${c}: ${cmp.firstDifference}`);
  }
  console.log(`[PASS] 2. Online prefix consistency CR=1.0 across ${cuts.length} cuts`);

  // Test 3: Append-only historical publication non-revision (HRR = 0.0 across 3 adversarial future suffixes)
  const prefixLen = 180;
  const prefixBars = bars.slice(0, prefixLen);
  const baseParser = new core.CTCoreParser(cfg);
  baseParser.ingestClosedBars(prefixBars);
  const baselineArchive = new Map();
  const basePub = baseParser.getConfirmedStructures();
  for (const layer of ['normalizedK', 'fractals', 'strokes', 'segments', 'pivots']) {
    for (const rec of basePub[layer]) baselineArchive.set(`${layer}:${rec.structureId}`, JSON.stringify(rec));
  }
  let suffixChecks = 0;
  for (const [label, bias] of [['observed', 0.0], ['strong_up', 2.5], ['strong_down', -2.5]]) {
    const suffix = label === 'observed'
      ? bars.slice(prefixLen)
      : generateSyntheticStream(60, 999 + Math.round(bias * 10), bias).map((b, i) => ({
          ...b, index: prefixLen + i,
          startTime: prefixBars.at(-1).startTime + (i + 1) * 60_000,
          endTime: prefixBars.at(-1).startTime + (i + 1) * 60_000 + 59_999,
        }));
    const ext = new core.CTCoreParser(cfg);
    ext.ingestClosedBars([...prefixBars, ...suffix]);
    const extPub = ext.getConfirmedStructures();
    const extMap = new Map();
    for (const layer of ['normalizedK', 'fractals', 'strokes', 'segments', 'pivots']) {
      for (const rec of extPub[layer]) extMap.set(`${layer}:${rec.structureId}`, JSON.stringify(rec));
    }
    for (const [key, serialized] of baselineArchive.entries()) {
      assert.equal(extMap.get(key), serialized, `Historical publication mutated under suffix=${label}: ${key}`);
      suffixChecks += 1;
    }
  }
  console.log(`[PASS] 3. Historical publication non-revision HRR=0.0 across ${suffixChecks} archived record checks`);

  // Test 4: Future-only Snapshot v5 checkpoint restart continuity (zero pre-checkpoint bar replay)
  const checkpoints = [40, 110, 190];
  let stepMatches = 0;
  for (const k0 of checkpoints) {
    const cont = new core.CTCoreParser(cfg);
    cont.ingestClosedBars(bars.slice(0, k0));
    const snap = cont.snapshot();
    const restored = new core.CTCoreParser(cfg).restore(snap);
    for (let k = k0; k < bars.length; k += 1) {
      cont.ingestClosedBar(bars[k]);
      restored.ingestClosedBar(bars[k]);
      assert.equal(
        JSON.stringify(cont.getConfirmedStructures()),
        JSON.stringify(restored.getConfirmedStructures()),
        `Restart publication divergence at k0=${k0}, k=${k}`
      );
      stepMatches += 1;
    }
  }
  console.log(`[PASS] 4. Future-only Snapshot v5 checkpoint restart continuity (${checkpoints.length} checkpoints, ${stepMatches}/${stepMatches} future steps)`);

  // Test 5: Microscopic spacing rule sensitivity (minimumStrokeSeparation = 2 vs 4)
  const pm4 = new core.CTCoreParser(loadRuleConfig({ minimumStrokeSeparation: 4 }));
  pm4.ingestClosedBars(bars);
  const sm4 = pm4.getConfirmedStructures();
  assert.equal(s1.normalizedK.length, sm4.normalizedK.length, 'K should be invariant to stroke spacing');
  assert.equal(s1.fractals.length, sm4.fractals.length, 'F should be invariant to stroke spacing');
  assert.ok(sm4.strokes.length < s1.strokes.length, 'm=4 should produce strictly fewer strokes than m=2');
  console.log(`[PASS] 5. Microscopic spacing sensitivity verified (K/F invariant; Strokes m=2: ${s1.strokes.length} -> m=4: ${sm4.strokes.length})`);

  // Test 6: Audit-hooks-off bit-for-bit structural equivalence
  const pf = new coreFast.CTCoreParser(cfg);
  pf.ingestClosedBars(bars);
  const hFull = crypto.createHash('sha256').update(JSON.stringify(s1)).digest('hex');
  const hFast = crypto.createHash('sha256').update(JSON.stringify(pf.getConfirmedStructures())).digest('hex');
  assert.equal(hFull, hFast, 'Audit-hooks-off structural hash mismatch');
  console.log(`[PASS] 6. Audit-hooks-off structural equivalence verified (SHA-256=${hFull.slice(0, 16)}...)`);
  console.log('\nALL 6 SYNTHETIC VERIFICATION CHECKS PASSED.');
}

runSuite();
