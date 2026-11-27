import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

export const PLAYER_ROOT = process.env.CT_PLAYER_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
export const R7_INPUTS = process.env.CT_WINDOWS_DIR || './local_windows';
export const OUT_DIR = process.env.CT_RESULTS_DIR || './results';

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
 * Isolated read-only VM loader for CT-Core-Parser-R1.0.4 (never mutates frozen source files).
 * Modes:
 *   - 'full_audit'      : Exact unmodified CT-Core-Parser-R1.0.4.
 *   - 'no_step_hash'    : Single-factor ablation disabling per-step attachStateHash SHA-256 only.
 *   - 'audit_hooks_off' : Disables only the three non-semantic diagnostic/audit hooks
 *                         (attachStateHash, estimateActiveMemorySize, and per-step clonePlain/deepFreeze),
 *                         preserving 100% of structural transition logic unchanged.
 */
export function createSandboxCore(mode = 'full_audit') {
  const context = vm.createContext({ window: {}, console, performance });
  for (const relative of CORE_SCRIPTS) {
    let src = fs.readFileSync(path.join(PLAYER_ROOT, relative), 'utf8');
    if (mode === 'audit_hooks_off' && relative === 'src/ct-v5/model.js') {
      src = src
        .replace('function clonePlain(value) {', 'function clonePlain(value) { return value;')
        .replace('function deepFreeze(value) {', 'function deepFreeze(value) { return value;')
        .replace('function estimateActiveMemorySize(value) {', 'function estimateActiveMemorySize(value) { return 0;');
    }
    if ((mode === 'no_step_hash' || mode === 'audit_hooks_off') && relative === 'src/ct-v5/state-hash.js') {
      src = src.replace(
        'function attachStateHash(state, options = {}) {',
        mode === 'audit_hooks_off'
          ? 'function attachStateHash(state, options = {}) { return { ...state, stateHash: null };'
          : 'function attachStateHash(state, options = {}) { return (core.deepFreeze || Object.freeze)({ ...state, stateHash: null });'
      );
    }
    vm.runInContext(src, context, { filename: relative });
  }
  const core = context.window.MarketCore;
  if (core.CT_CORE_PARSER_VERSION !== 'CT-Core-Parser-R1.0.4') {
    throw new Error(`CORE_VERSION_MISMATCH:${core.CT_CORE_PARSER_VERSION}`);
  }
  return core;
}

export function loadFrozenRuleConfig(overrides = {}) {
  const base = JSON.parse(
    fs.readFileSync(path.join(PLAYER_ROOT, 'contracts/ct-core-parser-r1.0.3.json'), 'utf8')
  ).frozenRuleConfig;
  return { ...base, ...overrides };
}
