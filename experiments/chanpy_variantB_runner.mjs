import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { PLAYER_ROOT, loadFrozenRuleConfig, R7_INPUTS, OUT_DIR } from './sandbox_core.mjs';

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

/**
 * Isolated VM loader for R5 Variant B (CT-Endpoint-R5-B-FeatureFractalOnly-v1.0):
 * identical to audit_hooks_off EXCEPT evaluateDirectionalExtremeEndpoint returns valid: true
 * (matching frozen R5_ENDPOINT_B.json semantics).
 */
function createVariantBSandboxCore() {
  const context = vm.createContext({ window: {}, console, performance });
  for (const relative of CORE_SCRIPTS) {
    let src = fs.readFileSync(path.join(PLAYER_ROOT, relative), 'utf8');
    if (relative === 'src/ct-v5/model.js') {
      src = src
        .replace('function clonePlain(value) {', 'function clonePlain(value) { return value;')
        .replace('function deepFreeze(value) {', 'function deepFreeze(value) { return value;')
        .replace('function estimateActiveMemorySize(value) {', 'function estimateActiveMemorySize(value) { return 0;');
    }
    if (relative === 'src/ct-v5/state-hash.js') {
      src = src.replace(
        'function attachStateHash(state, options = {}) {',
        'function attachStateHash(state, options = {}) { return { ...state, stateHash: null };'
      );
    }
    if (relative === 'src/ct-v5/segment-case1.js') {
      const target = 'const valid = Math.abs(input.endpointPrice - extreme) <= tolerance &&\n      (input.direction === \'UP\' ? input.endpointPrice > input.startPrice : input.endpointPrice < input.startPrice);';
      const targetCRLF = target.replace(/\n/g, '\r\n');
      if (src.includes(targetCRLF)) {
        src = src.replace(targetCRLF, 'const valid = true;');
      } else if (src.includes(target)) {
        src = src.replace(target, 'const valid = true;');
      } else {
        throw new Error('Failed to locate Variant B guard line in segment-case1.js');
      }
    }
    vm.runInContext(src, context, { filename: relative });
  }
  return context.window.MarketCore;
}

function extractComparable(core, ruleConfig, bars) {
  const parser = new core.CTCoreParser(ruleConfig);
  for (const b of bars) parser.ingestClosedBar({ ...b, closed: true });
  const sealed = parser.getConfirmedStructures();
  const current = parser.getCurrentStructures();

  const kSupportById = new Map();
  for (const k of current.normalizedK) {
    const a = k.geometry.sourceStartRawBarIndex;
    const b = k.geometry.sourceEndRawBarIndex;
    const sup = [];
    for (let x = a; x <= b; x += 1) sup.push(x);
    kSupportById.set(k.structureId, sup);
  }
  const fMiddleSupportById = new Map();
  for (const f of current.fractals) {
    if (f.sourceIds && f.sourceIds.length === 3 && kSupportById.has(f.sourceIds[1])) {
      fMiddleSupportById.set(f.structureId, kSupportById.get(f.sourceIds[1]));
    }
  }
  const bSupportsById = new Map();
  for (const b of current.strokes) {
    if (b.sourceIds && b.sourceIds.length === 2) {
      const s0 = fMiddleSupportById.get(b.sourceIds[0]);
      const s1 = fMiddleSupportById.get(b.sourceIds[1]);
      if (s0 && s1) bSupportsById.set(b.structureId, [s0, s1]);
    }
  }
  function makeAnchors(layer, startSup, endSup) {
    const cStart = layer === 'K' ? startSup[0] : startSup[startSup.length - 1];
    const cEnd = endSup[endSup.length - 1];
    return [cStart, cEnd, cEnd];
  }
  const out = { K: [], F: [], B: [], S: [], Z_count: sealed.pivots.length };
  for (const k of sealed.normalizedK) {
    const sup = kSupportById.get(k.structureId);
    out.K.push({
      id: k.structureId, direction: k.direction, startSupport: sup, endSupport: sup,
      commonAnchors: makeAnchors('K', sup, sup), comparableGeometry: [k.geometry.high, k.geometry.low],
      eventRawIndex: k.eventRawBarIndex, startRawIndex: sup[0], endRawIndex: sup[sup.length - 1],
      eligible: Boolean(sup), exclusionReason: sup ? null : 'NOT_COMPARABLE:MISSING_K_SUPPORT',
    });
  }
  for (const f of sealed.fractals) {
    const sup = fMiddleSupportById.get(f.structureId);
    out.F.push({
      id: f.structureId, direction: f.geometry.type, startSupport: sup || [], endSupport: sup || [],
      commonAnchors: sup ? makeAnchors('F', sup, sup) : [], comparableGeometry: [f.geometry.price],
      eventRawIndex: f.eventRawBarIndex, startRawIndex: sup ? sup[0] : null, endRawIndex: sup ? sup[sup.length - 1] : null,
      eligible: Boolean(sup), exclusionReason: sup ? null : 'NOT_COMPARABLE:MISSING_F_SUPPORT',
    });
  }
  for (const b of sealed.strokes) {
    const pair = bSupportsById.get(b.structureId);
    out.B.push({
      id: b.structureId, direction: b.direction, startSupport: pair ? pair[0] : [], endSupport: pair ? pair[1] : [],
      commonAnchors: pair ? makeAnchors('B', pair[0], pair[1]) : [],
      comparableGeometry: [b.geometry.startPrice, b.geometry.endPrice],
      eventRawIndex: b.eventRawBarIndex, startRawIndex: b.geometry.startRawBarIndex, endRawIndex: b.geometry.endRawBarIndex,
      eligible: Boolean(pair), exclusionReason: pair ? null : 'NOT_COMPARABLE:MISSING_B_SUPPORT',
    });
  }
  for (const s of sealed.segments) {
    const firstB = s.sourceIds?.length ? bSupportsById.get(s.sourceIds[0]) : null;
    const lastB = s.sourceIds?.length ? bSupportsById.get(s.sourceIds[s.sourceIds.length - 1]) : null;
    const ok = Boolean(firstB && lastB);
    out.S.push({
      id: s.structureId, direction: s.direction, startSupport: ok ? firstB[0] : [], endSupport: ok ? lastB[1] : [],
      commonAnchors: ok ? makeAnchors('S', firstB[0], lastB[1]) : [],
      comparableGeometry: [s.geometry.startPrice, s.geometry.endPrice],
      eventRawIndex: s.eventRawBarIndex, startRawIndex: s.geometry.startRawBarIndex, endRawIndex: s.geometry.endRawBarIndex,
      eligible: ok, exclusionReason: ok ? null : 'NOT_COMPARABLE:MISSING_S_SUPPORT',
    });
  }
  return out;
}

const coreB = createVariantBSandboxCore();
const files = fs.readdirSync(R7_INPUTS).filter(f => f.endsWith('.json')).sort();
if (files.length !== 14) throw new Error(`Expected 14 inputs, got ${files.length}`);

const configs = {
  internal_m2_varB: loadFrozenRuleConfig({ minimumStrokeSeparation: 2 }),
  internal_m4_varB: loadFrozenRuleConfig({ minimumStrokeSeparation: 4 }),
};
const result = { internal_m2_varB: {}, internal_m4_varB: {} };
const totals = { internal_m2_varB: { K: 0, F: 0, B: 0, S: 0, Z: 0 }, internal_m4_varB: { K: 0, F: 0, B: 0, S: 0, Z: 0 } };

for (const file of files) {
  const wid = file.replace('.json', '');
  const bars = JSON.parse(fs.readFileSync(path.join(R7_INPUTS, file), 'utf8')).bars;
  for (const [label, cfg] of Object.entries(configs)) {
    const r = extractComparable(coreB, cfg, bars);
    result[label][wid] = r;
    totals[label].K += r.K.length;
    totals[label].F += r.F.length;
    totals[label].B += r.B.length;
    totals[label].S += r.S.length;
    totals[label].Z += r.Z_count;
  }
}

console.log('Variant B verification (m=2 must match frozen R5 Variant B: K=6759, F=3055, B=1163, S=85, Z=11):');
console.log('  m=2 Variant B:', totals.internal_m2_varB);
console.log('  m=4 Variant B:', totals.internal_m4_varB);

if (totals.internal_m2_varB.K !== 6759 || totals.internal_m2_varB.F !== 3055 ||
    totals.internal_m2_varB.B !== 1163 || totals.internal_m2_varB.S !== 85 || totals.internal_m2_varB.Z !== 11) {
  throw new Error('VARIANT_B_MISMATCH_WITH_FROZEN_R5!');
}
console.log('EXACT BIT-FOR-BIT MATCH WITH FROZEN R5 VARIANT B VERIFIED!');

const outPath = path.join(OUT_DIR, 'chanpy_variantB_projections.json');
fs.writeFileSync(outPath, JSON.stringify({ totals, ...result }) + '\n', 'utf8');
console.log('Saved:', outPath);
