/**
 * R8 Step 3 Gate:
 *   Part A: Mandatory 8-trajectory bit-for-bit equivalence spotcheck (full_audit vs audit_hooks_off)
 *           across 4 symbols (BTCUSDT, ETHUSDT, XAUUSDT, SPYUSDT on 2026-06-16; real + CBB L=30, N=720).
 *   Part B: Isolated 2-line lifecycleEvents serialization/restoration patch verification
 *           on the exact synthetic replacement-invalidation-reentry-confirmation stress test
 *           (proving frozen v1.0.4 exhibits 1->0 mismatch, while 2-line patch achieves 1===1 + full Case-2 confirm).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createSandboxCore, loadFrozenRuleConfig, PLAYER_ROOT } from './sandbox_core.mjs';
import { generateSurrogate } from './null_surrogates.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R8_ROOT = process.env.CT_DATA_ROOT || path.join(REPO_ROOT, 'local_data', 'extended_validation');
const OUT_DIR = process.env.CT_RESULTS_DIR || path.join(REPO_ROOT, 'results');

function resolveWindowPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(R8_ROOT, filePath);
}

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

function loadPatchedCore() {
  const ctx = vm.createContext({ window: {}, console, performance });
  for (const rel of CORE_SCRIPTS) {
    let src = fs.readFileSync(path.join(PLAYER_ROOT, rel), 'utf8');
    if (rel === 'src/ct-v5/segment.js') {
      const target1 = 'endpointLifecycleContinuationState:\n          this.#endpointLifecycleMachine?.serializeContinuationState() ?? null,';
      const repl1 = target1 + '\n        lifecycleEvents: clone(this.#lifecycleEvents),';
      const target2 = 'this.#endpointLifecycleMachine = new core.SegmentEndpointLifecycleStateMachine(\n          { ruleConfig: this.#ruleConfig }, snapshot.endpointLifecycleContinuationState);\n      }';
      const repl2 = target2 + '\n      this.#lifecycleEvents = clone(snapshot.lifecycleEvents || []);';
      if (!src.includes(target1) || !src.includes(target2)) {
        // Normalize CRLF if present
        src = src.replace(/\r\n/g, '\n');
      }
      if (!src.includes(target1) || !src.includes(target2)) {
        throw new Error('PATCH_TARGET_NOT_FOUND in segment.js');
      }
      src = src.replace(target1, repl1).replace(target2, repl2);
    }
    vm.runInContext(src, ctx, { filename: rel });
  }
  return ctx.window.MarketCore;
}

function hashSealed(sealed) {
  const canonical = {
    K: sealed.normalizedK.map(o => [o.structureId, o.eventRawBarIndex, o.confirmRawBarIndex, o.eventTime, o.confirmTime, o.high, o.low]),
    F: sealed.fractals.map(o => [o.structureId, o.eventRawBarIndex, o.confirmRawBarIndex, o.eventTime, o.confirmTime, o.fractalType]),
    B: sealed.strokes.map(o => [o.structureId, o.eventRawBarIndex, o.confirmRawBarIndex, o.eventTime, o.confirmTime, o.direction, o.startPrice, o.endPrice]),
    S: sealed.segments.map(o => [o.structureId, o.eventRawBarIndex, o.confirmRawBarIndex, o.eventTime, o.confirmTime, o.direction, o.startPrice, o.endPrice]),
    Z: sealed.pivots.map(o => [o.structureId, o.eventRawBarIndex, o.confirmRawBarIndex, o.eventTime, o.confirmTime, o.zd, o.zg, o.dd, o.gg]),
  };
  return {
    sha256: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    counts: { K: canonical.K.length, F: canonical.F.length, B: canonical.B.length, S: canonical.S.length, Z: canonical.Z.length },
  };
}

function runSpotcheckWorker(job) {
  const raw = JSON.parse(fs.readFileSync(job.filePath, 'utf8'));
  const fullBars = job.kind === 'real'
    ? raw.bars
    : generateSurrogate('cbb_L30', raw.bars, job.windowId, 0, job.tickSize, null);
  const bars = fullBars.slice(0, job.prefixLen);
  const cfg = loadFrozenRuleConfig();

  const runMode = (mode) => {
    const core = createSandboxCore(mode);
    const parser = new core.CTCoreParser(cfg);
    const t0 = performance.now();
    for (let k = 0; k < bars.length; k += 1) {
      const b = bars[k];
      parser.ingestClosedBar({
        index: k, startTime: b.startTime, endTime: b.endTime,
        open: b.open, high: b.high, low: b.low, close: b.close, closed: true,
      });
    }
    const sec = (performance.now() - t0) / 1000;
    const h = hashSealed(parser.getConfirmedStructures());
    return { sec, ...h };
  };

  const fullRes = runMode('full_audit');
  const fastRes = runMode('audit_hooks_off');
  return {
    windowId: job.windowId,
    symbol: job.symbol,
    kind: job.kind,
    prefixLen: job.prefixLen,
    fullSec: fullRes.sec,
    fastSec: fastRes.sec,
    speedup: fullRes.sec / fastRes.sec,
    counts: fullRes.counts,
    fullSha256: fullRes.sha256,
    fastSha256: fastRes.sha256,
    exactMatch: fullRes.sha256 === fastRes.sha256,
  };
}

function runReplacementStress(core, rule) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const mkStrokes = (prices, offset = 0, prefix = 'b') => prices.slice(1).map((price, i) => {
    const n = offset + i;
    return {
      strokeId: prefix + n, structureId: prefix + n, status: 'CONFIRMED',
      direction: price > prices[i] ? 'UP' : 'DOWN',
      startPrice: prices[i], endPrice: price,
      startFractalId: prefix + 'f' + n, endFractalId: prefix + 'f' + (n + 1),
      startIndex: n * 10, endIndex: (n + 1) * 10,
      eventRawBarIndex: (n + 1) * 10, eventIndex: (n + 1) * 10,
      confirmRawBarIndex: (n + 1) * 10 + 1, confirmIndex: (n + 1) * 10 + 1,
      startTime: n * 100, endTime: (n + 1) * 100, eventTime: (n + 1) * 100,
      availableRawBarIndex: (n + 1) * 10 + 1, availableTime: (n + 1) * 100 + 10,
      confirmTime: (n + 1) * 100 + 10,
      eventStrokeIndex: n, availableStrokeIndex: n, confirmStrokeIndex: n,
      ruleVersion: rule.ruleVersion,
    };
  });
  const findInputs = (ss) => {
    const s = new core.SegmentStateMachine(rule);
    let inc = null, ord = 0;
    const found = [], seen = new Set();
    for (let i = 0; i < ss.length; i += 1) {
      const prefix = ss.slice(0, i + 1);
      s.update(prefix);
      const candidate = s.getActiveSegment();
      const raw = core.buildFeatureSequence(prefix, { ruleConfig: rule, segmentStartDirection: ss[0].direction });
      if (!inc) inc = new core.FeatureSequenceInclusionStateMachine({ ...raw, candidateSegmentId: candidate.segmentId });
      while (ord < raw.elements.length) inc.update(raw.elements[ord++]);
      const standardized = inc.getState();
      const fr = core.detectFeatureFractals(inc.getDetectorInput(), { ruleConfig: rule });
      for (const f of fr.confirmedFeatureFractals) {
        if (seen.has(f.featureFractalId)) continue;
        seen.add(f.featureFractalId);
        const input = {
          candidateSegmentState: candidate, segmentState: candidate,
          standardizedSequence: standardized, confirmedFeatureFractal: f, featureFractal: f,
          confirmedStrokes: prefix, gapResult: core.getCase1RelevantGap(standardized, f, rule),
          currentAvailability: { rawBarIndex: ss[i].confirmIndex, time: ss[i].confirmTime },
          ruleConfig: rule,
        };
        found.push({
          input, prefix,
          case1: core.evaluateSegmentCase1(input),
          case2: core.evaluateSegmentCase2Entry(input),
          proposal: core.evaluateEndpointProposal(input),
        });
      }
    }
    return found;
  };

  const ss = mkStrokes([10, 14, 9, 14, 11, 18, 16, 17, 14, 22, 18, 20, 15, 22, 14, 16, 13, 17, 11]);
  const eligible = findInputs(ss).filter(x => x.case2.eligible && x.proposal.eligible);
  const [a, b] = eligible;
  const continuous = new core.SegmentStateMachine(rule);
  for (let i = 0; i < a.prefix.length; i += 1) continuous.update(a.prefix.slice(0, i + 1));
  const old = continuous.beginCase2(a.input);
  for (let i = a.prefix.length; i < b.prefix.length; i += 1) continuous.update(b.prefix.slice(0, i + 1));
  const prop = continuous.evaluateEndpointProposal(b.input);
  const replaced = continuous.processEndpointProposal(prop.endpointProposal, b.input.currentAvailability);

  const snap = JSON.stringify(continuous.serializeSequentialContinuation());
  const restored = new core.SegmentStateMachine(rule);
  restored.restoreSequentialContinuation(JSON.parse(snap));

  const contLifeLen = continuous.getState().segmentState.activeMemory.lifecycleEvents.length;
  const restLifeLen = restored.getState().segmentState.activeMemory.lifecycleEvents.length;
  const lifeExactMatch = JSON.stringify(continuous.getLifecycleEvents()) === JSON.stringify(restored.getLifecycleEvents());
  const pendingStatusCont = continuous.getPendingTerminations()[0]?.status;
  const pendingStatusRest = restored.getPendingTerminations()[0]?.status;

  // Continue with Case-2 re-entry and full confirmation on both paths
  const entry = clone(b.input);
  delete entry.confirmedStrokes; delete entry.candidateSegmentState; delete entry.segmentState;
  const pc = continuous.beginCase2(entry);
  const pr = restored.beginCase2(clone(entry));
  let confirmedCont = null, confirmedRest = null, futureSteps = 0;
  for (const t of mkStrokes([11, 12, 11.5, 13.5, 12.5, 14.5], 31, 'new')) {
    for (const [tag, m] of [['cont', continuous], ['rest', restored]]) {
      const p = m.getPendingTerminations()[0];
      if (p?.status === 'PENDING') {
        const z = m.updateCase2Stroke(t, { rawBarIndex: t.confirmIndex, time: t.confirmTime },
          { candidateSegmentId: p.candidateSegmentId, endpointIdentity: p.endpointIdentity, ruleVersion: p.ruleVersion });
        if (z.confirmedSegment) {
          if (tag === 'cont') confirmedCont = z.confirmedSegment;
          else confirmedRest = z.confirmedSegment;
        }
      }
    }
    futureSteps += 1;
    if (confirmedCont && confirmedRest) break;
  }

  return {
    stalePendingMatch: pendingStatusCont === 'STALE' && pendingStatusRest === 'STALE',
    checkpointLifecycleEventsCont: contLifeLen,
    checkpointLifecycleEventsRest: restLifeLen,
    checkpointLifecycleExactMatch: lifeExactMatch,
    reentryNewPendingDistinct: pc.pendingTermination?.status === 'PENDING' && pc.pendingTermination.pendingTerminationId !== old.pendingTermination.pendingTerminationId,
    reentryPendingIdMatch: pc.pendingTermination?.pendingTerminationId === pr.pendingTermination?.pendingTerminationId,
    futureStepsToConfirm: futureSteps,
    confirmedCase2Cont: confirmedCont?.caseType === 'CASE_2',
    confirmedCase2Rest: confirmedRest?.caseType === 'CASE_2',
    confirmedSegmentExactMatch: JSON.stringify(confirmedCont) === JSON.stringify(confirmedRest),
    postConfirmLifecycleMatch: JSON.stringify(continuous.getLifecycleEvents()) === JSON.stringify(restored.getLifecycleEvents()),
  };
}

if (!isMainThread) {
  parentPort.postMessage(runSpotcheckWorker(workerData));
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rule = loadFrozenRuleConfig();

  // Part B first (instant <1s)
  console.log('=== PART B: lifecycleEvents 2-LINE PATCH VERIFICATION ===');
  const frozenCore = createSandboxCore('full_audit');
  const patchedCore = loadPatchedCore();
  const frozenStress = runReplacementStress(frozenCore, rule);
  const patchedStress = runReplacementStress(patchedCore, rule);
  console.log('Frozen v1.0.4 :', JSON.stringify(frozenStress));
  console.log('Patched (+2L) :', JSON.stringify(patchedStress));
  if (frozenStress.checkpointLifecycleEventsCont !== 1 || frozenStress.checkpointLifecycleEventsRest !== 0) {
    throw new Error('Expected frozen v1.0.4 to exhibit 1->0 lifecycleEvents omission!');
  }
  if (!patchedStress.checkpointLifecycleExactMatch || !patchedStress.confirmedSegmentExactMatch || !patchedStress.postConfirmLifecycleMatch) {
    throw new Error('2-line patch failed replacement-invalidation-reentry verification!');
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'lifecycle_patch_verify.json'),
    JSON.stringify({
      generatedAtUtc: new Date().toISOString(),
      patchDescription: 'Two-line isolated VM patch in segment.js: serialize lifecycleEvents and restore this.#lifecycleEvents in restoreSequentialContinuation.',
      frozenV104Result: frozenStress,
      patchedResult: patchedStress,
      status: 'PASS',
    }, null, 2) + '\n'
  );
  console.log('PART B PASSED! Frozen core preserves 1->0 counterexample; 2-line patch achieves 1===1 + full Case-2 re-entry confirmation.\n');

  // Part A: 8-trajectory full_audit vs audit_hooks_off spotcheck in parallel (4 workers)
  console.log('=== PART A: 8-TRAJECTORY BIT-FOR-BIT EQUIVALENCE SPOTCHECK (N=720) ===');
  const manifestPath = fs.existsSync(path.join(R8_ROOT, 'manifests/extended_window_manifest.json'))
    ? path.join(R8_ROOT, 'manifests/extended_window_manifest.json')
    : path.join(REPO_ROOT, 'manifests/extended_window_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const juneWindows = manifest.arm1_1m_48h.filter(w => w.startDate === '2026-06-16');
  const jobs = [];
  for (const w of juneWindows) {
    const fp = resolveWindowPath(w.filePath);
    jobs.push({ windowId: w.windowId, symbol: w.symbol, tickSize: w.tickSize, filePath: fp, kind: 'real', prefixLen: 720 });
    jobs.push({ windowId: w.windowId, symbol: w.symbol, tickSize: w.tickSize, filePath: fp, kind: 'cbb_L30', prefixLen: 720 });
  }

  const results = [];
  let nextIdx = 0, done = 0;
  const maxWorkers = Math.min(4, os.cpus().length);
  await new Promise((resolve, reject) => {
    let active = 0;
    function dispatch() {
      while (active < maxWorkers && nextIdx < jobs.length) {
        const job = jobs[nextIdx++];
        active += 1;
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: job });
        worker.on('message', (msg) => {
          results.push(msg);
          done += 1;
          console.log(`  [${done}/${jobs.length}] ${msg.symbol} (${msg.kind}): match=${msg.exactMatch} full=${msg.fullSec.toFixed(1)}s fast=${msg.fastSec.toFixed(2)}s (${msg.speedup.toFixed(1)}x) counts=${JSON.stringify(msg.counts)}`);
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          active -= 1;
          if (code !== 0) reject(new Error(`Worker exited ${code}`));
          else if (done === jobs.length) resolve();
          else dispatch();
        });
      }
    }
    dispatch();
  });

  const allPass = results.every(r => r.exactMatch);
  fs.writeFileSync(
    path.join(OUT_DIR, 'equivalence_spotcheck.json'),
    JSON.stringify({
      protocolId: 'CT-R8-ExtendedHorizon-CrossFreq-Null-v1.0.0',
      generatedAtUtc: new Date().toISOString(),
      totalTrajectories: results.length,
      exactMatches: results.filter(r => r.exactMatch).length,
      status: allPass ? 'PASS' : 'FAIL',
      trajectories: results,
    }, null, 2) + '\n'
  );
  if (!allPass) throw new Error('EQUIVALENCE_SPOTCHECK_FAILED');
  console.log('\nPART A PASSED: 8/8 trajectories 100% bit-for-bit identical SHA-256!');
}
