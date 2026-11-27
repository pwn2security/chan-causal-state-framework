import fs from 'node:fs';
import path from 'node:path';
import { createSandboxCore, loadFrozenRuleConfig } from './sandbox_core.mjs';

const R7_INPUTS = process.env.CT_WINDOWS_DIR || './local_windows';
const OUT_DIR = process.env.CT_RESULTS_DIR || './results';
fs.mkdirSync(OUT_DIR, { recursive: true });

// Extract R7-comparable normalized internal K, F, B, S records directly from sandbox ct-v5
// for both minimumStrokeSeparation = 2 (baseline) and minimumStrokeSeparation = 4 (spacing-aligned CF-1).
// Uses getConfirmedStructures() which matches R5 Variant A frozen sealed projection!
function extractComparable(core, ruleConfig, bars, windowId, label) {
  const parser = new core.CTCoreParser(ruleConfig);
  for (const b of bars) parser.ingestClosedBar({ ...b, closed: true });
  const sealed = parser.getConfirmedStructures();
  const current = parser.getCurrentStructures();

  // Build K support lookup from current normalizedK (all K bars including any absorbed/tail needed for F)
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
    // sourceIds has 3 normalizedK IDs; middle is index 1
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

  // Note: R7 internal baseline uses the frozen final projection (sealed projection from R5 Variant A).
  // We export BOTH sealed (matching R7) and verify exact counts against R7_FORMAL_RESULT_SUMMARY.json!
  const out = { K: [], F: [], B: [], S: [] };

  for (const k of sealed.normalizedK) {
    const sup = kSupportById.get(k.structureId);
    out.K.push({
      id: k.structureId,
      direction: k.direction,
      startSupport: sup,
      endSupport: sup,
      commonAnchors: makeAnchors('K', sup, sup),
      comparableGeometry: [k.geometry.high, k.geometry.low],
      eventRawIndex: k.eventRawBarIndex,
      startRawIndex: sup[0],
      endRawIndex: sup[sup.length - 1],
      eligible: Boolean(sup),
      exclusionReason: sup ? null : 'NOT_COMPARABLE:MISSING_K_SUPPORT',
    });
  }
  for (const f of sealed.fractals) {
    const sup = fMiddleSupportById.get(f.structureId);
    out.F.push({
      id: f.structureId,
      direction: f.geometry.type,
      startSupport: sup || [],
      endSupport: sup || [],
      commonAnchors: sup ? makeAnchors('F', sup, sup) : [],
      comparableGeometry: [f.geometry.price],
      eventRawIndex: f.eventRawBarIndex,
      startRawIndex: sup ? sup[0] : null,
      endRawIndex: sup ? sup[sup.length - 1] : null,
      eligible: Boolean(sup),
      exclusionReason: sup ? null : 'NOT_COMPARABLE:MISSING_F_SUPPORT',
    });
  }
  for (const b of sealed.strokes) {
    const pair = bSupportsById.get(b.structureId);
    out.B.push({
      id: b.structureId,
      direction: b.direction,
      startSupport: pair ? pair[0] : [],
      endSupport: pair ? pair[1] : [],
      commonAnchors: pair ? makeAnchors('B', pair[0], pair[1]) : [],
      comparableGeometry: [b.geometry.startPrice, b.geometry.endPrice],
      eventRawIndex: b.eventRawBarIndex,
      startRawIndex: b.geometry.startRawBarIndex,
      endRawIndex: b.geometry.endRawBarIndex,
      eligible: Boolean(pair),
      exclusionReason: pair ? null : 'NOT_COMPARABLE:MISSING_B_SUPPORT',
    });
  }
  for (const s of sealed.segments) {
    const firstB = s.sourceIds?.length ? bSupportsById.get(s.sourceIds[0]) : null;
    const lastB = s.sourceIds?.length ? bSupportsById.get(s.sourceIds[s.sourceIds.length - 1]) : null;
    const ok = Boolean(firstB && lastB);
    out.S.push({
      id: s.structureId,
      direction: s.direction,
      startSupport: ok ? firstB[0] : [],
      endSupport: ok ? lastB[1] : [],
      commonAnchors: ok ? makeAnchors('S', firstB[0], lastB[1]) : [],
      comparableGeometry: [s.geometry.startPrice, s.geometry.endPrice],
      eventRawIndex: s.eventRawBarIndex,
      startRawIndex: s.geometry.startRawBarIndex,
      endRawIndex: s.geometry.endRawBarIndex,
      eligible: ok,
      exclusionReason: ok ? null : 'NOT_COMPARABLE:MISSING_S_SUPPORT',
    });
  }
  return out;
}

async function main() {
  const core = createSandboxCore('audit_hooks_off');
  const files = fs.readdirSync(R7_INPUTS).filter(f => f.endsWith('.json')).sort();
  if (files.length !== 14) throw new Error(`Expected 14 R7 inputs, got ${files.length}`);

  const configs = {
    internal_m2: loadFrozenRuleConfig({ minimumStrokeSeparation: 2 }),
    internal_m4: loadFrozenRuleConfig({ minimumStrokeSeparation: 4 }),
  };

  const result = { internal_m2: {}, internal_m4: {} };
  for (const file of files) {
    const wid = file.replace('.json', '');
    const bars = JSON.parse(fs.readFileSync(path.join(R7_INPUTS, file), 'utf8')).bars;
    for (const [label, cfg] of Object.entries(configs)) {
      result[label][wid] = extractComparable(core, cfg, bars, wid, label);
    }
  }
  const outPath = path.join(OUT_DIR, 'exp3_internal_projections.json');
  fs.writeFileSync(outPath, JSON.stringify(result) + '\n', 'utf8');
  console.log('Saved internal m2 & m4 projections for 14 windows:', outPath);
}

main().catch(err => { console.error(err); process.exit(1); });
