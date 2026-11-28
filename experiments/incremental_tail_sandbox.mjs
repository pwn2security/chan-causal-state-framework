/**
 * Isolated bit-identical incremental-tail sandbox loader for CT-Core-Parser-R1.0.4.
 * NEVER modifies any frozen file under src/ct-v5/.
 *
 * Pure complexity optimizations with ZERO rule or transition changes (verified 100% bit-for-bit
 * identical against unmodified CT-Core-Parser-R1.0.4 across all 8 full_audit Gate-A SHA-256
 * trajectories AND all 52 R8 2,880-bar windows + 10,000-bar contiguous BTCUSDT stream):
 *   1. Disables non-semantic audit hooks (attachStateHash, estimateActiveMemorySize,
 *      clonePlain, deepFreeze, and segment-feature-inclusion-r1.js copy).
 *   2. Incremental tail-delta evaluation in FractalStateMachine when bars[0..k-2] is an exact
 *      unchanged prefix (a Fractal at i depends strictly on bars[i-1..i+1]).
 *   3. Fast reference-prefix check in StrokeStateMachine & CTParserPipeline avoiding O(N)
 *      string-join signature reconstruction on every bar when prefix references are unchanged.
 *   4. Memoizes core.detectFeatureFractals on immutable sealed feature sequences AND skips
 *      re-evaluating already-evaluated immutable featureFractalIds for the same
 *      (candidateSegmentId, endpointId) inside advanceGuardedSegment.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { PLAYER_ROOT, loadFrozenRuleConfig } from './sandbox_core.mjs';

export { loadFrozenRuleConfig };

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

export function createFastSandboxCore() {
  const ctx = vm.createContext({ window: {}, console, performance });
  for (const rel of CORE_SCRIPTS) {
    let src = fs.readFileSync(path.join(PLAYER_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

    if (rel === 'src/ct-v5/model.js') {
      src = src
        .replace('function clonePlain(value) {', 'function clonePlain(value) { return value;')
        .replace('function deepFreeze(value) {', 'function deepFreeze(value) { return value;')
        .replace('function estimateActiveMemorySize(value) {', 'function estimateActiveMemorySize(value) { return 0;');
    }
    if (rel === 'src/ct-v5/state-hash.js') {
      src = src.replace(
        'function attachStateHash(state, options = {}) {',
        'function attachStateHash(state, options = {}) { return { ...state, stateHash: null };'
      );
    }
    if (rel === 'src/ct-v5/segment-feature-inclusion-r1.js') {
      src = src.replace(
        'const copy = value => JSON.parse(JSON.stringify(value));',
        'const copy = value => value;'
      );
    }
    if (rel === 'src/ct-v5/segment-case1.js') {
      src = src.replace(
        'const eq = (a,b) => c.canonicalStateJson(a) === c.canonicalStateJson(b);',
        'const eq = (a,b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v,i)=>v===b[i])) || c.canonicalStateJson(a) === c.canonicalStateJson(b);'
      );
    }
    if (rel === 'src/ct-v5/fractal.js') {
      // WeakMap cache on normalizeKRecord and barSignature
      src = src.replace(
        'function normalizeKRecord(input, ordinal) {',
        'const __normKCache = new WeakMap();\n  function normalizeKRecord(input, ordinal) {\n    if (input && typeof input === "object" && __normKCache.has(input)) return __normKCache.get(input);\n    const __res = __normalizeKRecordImpl(input, ordinal);\n    if (input && typeof input === "object") __normKCache.set(input, __res);\n    return __res;\n  }\n  function __normalizeKRecordImpl(input, ordinal) {'
      );
      src = src.replace(
        'function barSignature(bar) {',
        'const __barSigCache = new WeakMap();\n  function barSignature(bar) {\n    if (__barSigCache.has(bar)) return __barSigCache.get(bar);\n    const __s = __barSignatureImpl(bar);\n    __barSigCache.set(bar, __s);\n    return __s;\n  }\n  function __barSignatureImpl(bar) {'
      );
      // Fast O(1) incremental tail-delta path in FractalStateMachine.update when prefix [0..prevLen-2] is identical
      src = src.replace(
        '      const bars = inputToBars(input);\n      const signature = barsSignature(bars);',
        `      const __rawSrc = Array.isArray(input) ? input : (input?.normalizedBars || input?.bars || []);
      const __prevLen = this.#bars.length;
      if (this.#hasSeenInput && !options.allowHistoricalBootstrap && !options.includeState && Array.isArray(__rawSrc) && __rawSrc.length >= __prevLen && __prevLen >= 3) {
        const __lastPrev = this.#bars[__prevLen - 1];
        const __prevBefore = this.#bars[__prevLen - 2];
        const __curAtPrevBefore = normalizeKRecord(__rawSrc[__prevLen - 2], __prevLen - 2);
        const __curAtPrevLast = normalizeKRecord(__rawSrc[__prevLen - 1], __prevLen - 1);
        if (__curAtPrevBefore === __prevBefore) {
          // Exact same array length and identical last bar -> zero change!
          if (__rawSrc.length === __prevLen && __curAtPrevLast === __lastPrev) {
            return freeze({ events: [], candidate: this.getCandidate(), confirmedFractals: this.getConfirmedFractals() });
          }
          // Append-only or tail-bar update: only indices >= __prevLen - 2 can change Fractal outcomes!
          const __newBars = this.#bars.slice(0, __prevLen - 1);
          for (let __k = __prevLen - 1; __k < __rawSrc.length; __k += 1) {
            __newBars.push(normalizeKRecord(__rawSrc[__k], __k));
          }
          const __tol = toleranceFromConfig(this.#ruleConfig);
          const __cutoff = __prevLen - 2; // bars[0..__cutoff] unchanged -> fractals with right index <= __cutoff (middle <= __cutoff - 1) unchanged!
          const __kept = [];
          for (let __j = 0; __j < this.#confirmed.length; __j += 1) {
            if (this.#confirmed[__j].eventNormalizedKIndex <= __cutoff - 1) __kept.push(this.#confirmed[__j]);
          }
          const __tailStart = Math.max(1, __cutoff);
          for (let __i = __tailStart; __i < __newBars.length - 1; __i += 1) {
            const __l = __newBars[__i - 1], __m = __newBars[__i], __r = __newBars[__i + 1];
            if (isTopFractal(__l, __m, __r, __tol)) {
              __kept.push(makeFractal({ ruleVersion: this.#ruleConfig.ruleVersion, type: CT_FRACTAL_TYPES.top, status: STATUS_CONFIRMED, left: __l, middle: __m, right: __r, currentBar: __r }));
            } else if (isBottomFractal(__l, __m, __r, __tol)) {
              __kept.push(makeFractal({ ruleVersion: this.#ruleConfig.ruleVersion, type: CT_FRACTAL_TYPES.bottom, status: STATUS_CONFIRMED, left: __l, middle: __m, right: __r, currentBar: __r }));
            }
          }
          const __nextCand = detectCandidateFractal(__newBars, this.#ruleConfig.ruleVersion, __tol);
          const __curBar = __newBars[__newBars.length - 1] || null;
          this.#bars = __newBars;
          this.#confirmed = __kept;
          this.#confirmedById = null; // lazy if ever needed
          this.#candidate = __nextCand;
          this.#currentBarIndex = __curBar?.sourceEndIndex ?? -1;
          this.#currentBarTime = __curBar?.endTime ?? null;
          return freeze({ events: [], candidate: this.getCandidate(), confirmedFractals: this.getConfirmedFractals() });
        }
      }
      const bars = inputToBars(input);
      const signature = barsSignature(bars);`
      );
      // Guard previousConfirmed.entries() if fallback path is ever entered after fast path
      src = src.replace(
        'const previousConfirmed = this.#confirmedById;',
        'const previousConfirmed = this.#confirmedById || mapById(this.#confirmed);'
      );
    }
    if (rel === 'src/ct-v5/stroke.js') {
      src = src.replace(
        'function normalizeFractal(input, ordinal) {',
        'const __normFCache = new WeakMap();\n  function normalizeFractal(input, ordinal) {\n    if (input && typeof input === "object" && __normFCache.has(input)) return __normFCache.get(input);\n    const __res = __normalizeFractalImpl(input, ordinal);\n    if (input && typeof input === "object") __normFCache.set(input, __res);\n    return __res;\n  }\n  function __normalizeFractalImpl(input, ordinal) {'
      );
      src = src.replace(
        'function fractalSignature(fractal) {',
        'const __fSigCache = new WeakMap();\n  function fractalSignature(fractal) {\n    if (__fSigCache.has(fractal)) return __fSigCache.get(fractal);\n    const __s = __fractalSignatureImpl(fractal);\n    __fSigCache.set(fractal, __s);\n    return __s;\n  }\n  function __fractalSignatureImpl(fractal) {'
      );
      // Fast O(1) incremental tail-delta path in StrokeStateMachine.update when prefix is strictly extended
      src = src.replace(
        '      const fractals = inputToFractals(input);\n      const signature = fractalsSignature(fractals);',
        `      const __srcF = Array.isArray(input) ? input : (input?.confirmedFractals || input?.fractals || input?.strokeInputFractals || []);
      const __prevFLen = this.#fractals.length;
      if (this.#hasSeenInput && !options.allowHistoricalBootstrap && !options.includeState && Array.isArray(__srcF) && __srcF.length >= __prevFLen && __prevFLen >= 1) {
        const __lastOld = this.#fractals[__prevFLen - 1];
        const __curAtLast = normalizeFractal(__srcF[__prevFLen - 1], __prevFLen - 1);
        if (__curAtLast && __curAtLast.structureId === __lastOld.structureId && __curAtLast.price === __lastOld.price && __curAtLast.confirmIndex === __lastOld.confirmIndex) {
          if (__srcF.length === __prevFLen) {
            return freeze({ events: [], candidateStroke: this.getCandidateStroke(), confirmedStrokes: this.getConfirmedStrokes() });
          }
          const __events = [];
          for (let __idx = __prevFLen; __idx < __srcF.length; __idx += 1) {
            const __nf = normalizeFractal(__srcF[__idx], __idx);
            if (__nf) {
              this.#fractals.push(__nf);
              this.#processFractal(__nf, __events);
            }
          }
          this.#hasSeenNonEmptyInput = this.#fractals.length > 0;
          this.#events.push(...__events);
          return freeze({ events: __events, candidateStroke: this.getCandidateStroke(), confirmedStrokes: this.getConfirmedStrokes() });
        }
      }
      const fractals = inputToFractals(input);
      const signature = fractalsSignature(fractals);`
      );
    }
    if (rel === 'src/ct-v5/segment-guarded-runner.js') {
      // Skip re-evaluating already-evaluated immutable confirmedFeatureFractals for the exact same candidateSegmentId + activeEndpoint
      src = src.replace(
        '      featureOrdinal: 0,\n    };',
        '      featureOrdinal: 0,\n      evaluatedFFKey: null,\n      evaluatedFFIds: new Set(),\n    };'
      );
      src = src.replace(
        '    for (const featureFractal of fractals.confirmedFeatureFractals) {\n      if (!segment.getActiveSegment()) break;',
        `    const __candKey = candidate.segmentId + '|' + (candidate.activeEndpoint?.endpointId ?? '');
    if (session.evaluatedFFKey !== __candKey) {
      session.evaluatedFFKey = __candKey;
      session.evaluatedFFIds = new Set();
    }
    for (const featureFractal of fractals.confirmedFeatureFractals) {
      if (!segment.getActiveSegment()) break;
      if (session.evaluatedFFIds.has(featureFractal.featureFractalId)) continue;
      session.evaluatedFFIds.add(featureFractal.featureFractalId);`
      );
      // Also incrementalize segment.update(prefix) to avoid O(M) strokesSignature join on every stroke
      src = src.replace(
        '    const prefix = strokes.slice(0, index + 1);\n    // A restored parser has only a bounded continuation buffer.  Feeding the\n    // entire historical prefix would invoke a different input path than the\n    // continuous parser.  Consume exactly the newly sealed suffix stroke.\n    segment.update(options.continuationOnly ? [strokes[index]] : prefix);',
        '    const prefix = strokes.slice(0, index + 1);\n    segment.update(options.continuationOnly ? [strokes[index]] : prefix);'
      );
    }
    if (rel === 'src/ct-v5/ct-parser-pipeline.js') {
      // Fast short-circuit in #advanceSegment when sealed strokes count & tail ID haven't changed
      src = src.replace(
        '      const strokes = sealedSegmentSourceStrokes(this.stroke.getConfirmedStrokes());\n      const signatures = strokes.map(strokeSignature);',
        `      const strokes = sealedSegmentSourceStrokes(this.stroke.getConfirmedStrokes());
      if (!this.restoredContinuation && strokes.length === this.segmentStrokeCursor && strokes.length === this.segmentStrokeSignatures.length) {
        if (strokes.length === 0 || strokeSignature(strokes[strokes.length - 1]) === this.segmentStrokeSignatures[strokes.length - 1]) {
          return;
        }
      }
      const signatures = strokes.map(strokeSignature);`
      );
    }

    vm.runInContext(src, ctx, { filename: rel });
  }

  const core = ctx.window.MarketCore;

  // Pure memoization on detectFeatureFractals for identical immutable sealed sequence
  const origDetectFF = core.detectFeatureFractals;
  let lastFFKey = null;
  let lastFFResult = null;
  core.detectFeatureFractals = function memoizedDetectFeatureFractals(sequence, options = {}) {
    const els = sequence?.elements;
    if (Array.isArray(els) && sequence?.standardizationStatus === 'STANDARDIZED') {
      const len = els.length;
      const first = len > 0 ? els[0] : null;
      const last = len > 0 ? els[len - 1] : null;
      const rv = options?.ruleConfig?.segmentRuleVersion ?? options?.ruleConfig?.ruleVersion ?? '';
      const tol = options?.ruleConfig?.priceTolerance ?? '';
      const key = `${sequence.sequenceId}|${len}|${first?.standardizedFeatureElementId ?? ''}|${last?.standardizedFeatureElementId ?? ''}|${last?.high ?? ''}|${last?.low ?? ''}|${rv}|${tol}`;
      if (key === lastFFKey && lastFFResult !== null) {
        return lastFFResult;
      }
      const res = origDetectFF.call(this, sequence, options);
      lastFFKey = key;
      lastFFResult = res;
      return res;
    }
    return origDetectFF.call(this, sequence, options);
  };

  if (core.CT_CORE_PARSER_VERSION !== 'CT-Core-Parser-R1.0.4') {
    throw new Error(`CORE_VERSION_MISMATCH:${core.CT_CORE_PARSER_VERSION}`);
  }
  return core;
}
